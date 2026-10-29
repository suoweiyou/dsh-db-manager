/**
 * Connection pool cache: one driver (and its underlying pool) per
 * (connection name, dialect, database-or-file, spec fingerprint) tuple, closed
 * with the plugin fiber. Dispatches to the right driver factory based on
 * `spec.dialect`; callers always see a `DatabaseDriver` and never branch on
 * dialect themselves.
 *
 * SQLite is intentionally cache-shaped like the server dialects even though
 * it has no pool: the same file reused across tool calls must hit the same
 * open Database so the plugin never races on close.
 *
 * Concurrency: `acquire` deduplicates concurrent calls for the same key by
 * caching the in-flight creation promise in `inflight`. Without this, two
 * parallel acquires for the same connection would each open their own
 * driver, the second `set` would shadow the first, and the first driver
 * (its pool + sockets + sqlite file handle) would leak.
 *
 * Cache-key design (audit N2/N5, 2nd round):
 *  - The driver cache is keyed per connection NAME via a nested Map, so
 *    names containing `::` can no longer collide across connections and
 *    close()/retainOnly() can never attribute a pool to the wrong name.
 *  - The inner key carries a fingerprint of the connection's security- and
 *    identity-relevant fields (host/port/username/password/file/ssl/
 *    extraParams). Editing a connection now produces a fresh driver and the
 *    outdated one is closed, instead of silently serving the previous
 *    host/credentials until restart.
 *  - SQLite re-validates its file path on EVERY acquire (not only at driver
 *    creation): the cache is process-wide and shared across sessions and
 *    workspaces, so a create-time-only check would let a later workspace
 *    bypass its own allowedRoots through a cache hit (audit N3).
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'
import type { ConnectionSpec, SshProfileSpec } from '../shared/types.js'
import type { DatabaseDriver, DriverFactoryOptions } from './dialect.js'
import { MysqlDriver } from './mysql-driver.js'
import { PgsqlDriver } from './pgsql-driver.js'
import { SqliteDriver } from './sqlite-driver.js'
import { openSshTunnel, type SshTunnelHandle } from './ssh-tunnel.js'

export interface PoolOptions {
  connectTimeoutMs: number
  queryTimeoutMs: number
  /**
   * Absolute paths the caller considers safe for SQLite file paths. When
   * provided, SQLite driver creation refuses any path outside one of these
   * roots (defends against configuration that points at `/etc/passwd`,
   * `C:\Windows\SAM`, etc.). Empty/undefined disables the check — used by
   * the GUI connectivity test, which only ever probes a single connection
   * the user explicitly picked.
   */
  allowedRoots?: ReadonlyArray<string>
  /**
   * FR-13: resolved SSH profile. When present the driver is pointed at a local
   * forwarded port instead of `spec.host:spec.port`, and the tunnel is closed
   * together with the driver/pool entry.
   */
  sshProfile?: SshProfileSpec
}

export type DriverCreator = (
  spec: ConnectionSpec,
  options: PoolOptions,
  database?: string,
) => Promise<DatabaseDriver>

const defaultDriverCreator: DriverCreator = async (spec, options, database) => {
  const factoryOptions: DriverFactoryOptions = { connectTimeoutMs: options.connectTimeoutMs, queryTimeoutMs: options.queryTimeoutMs }
  if (spec.dialect === 'postgresql') {
    return PgsqlDriver.create(spec, factoryOptions, database ?? spec.defaultDatabase)
  }
  if (spec.dialect === 'sqlite') {
    return SqliteDriver.create(spec, factoryOptions, { allowedRoots: options.allowedRoots ?? [] })
  }
  return MysqlDriver.create(spec, factoryOptions, database ?? spec.defaultDatabase)
}

/** Fields whose change must produce a fresh driver instead of a cache hit. */
function specFingerprint(spec: ConnectionSpec, ssh?: SshProfileSpec): string {
  const material = JSON.stringify({
    host: spec.host ?? null,
    port: spec.port ?? null,
    username: spec.username ?? null,
    password: spec.password ?? null,
    file: spec.file ?? null,
    ssl: spec.ssl ?? null,
    extraParams: spec.extraParams ?? null,
    // FR-13: editing the SSH profile (jump host, user, auth method or any
    // secret material) must rebuild the tunnel + driver, exactly like editing
    // the database credentials does.
    ssh:
      ssh === undefined
        ? null
        : {
            name: ssh.name,
            host: ssh.host,
            port: ssh.port ?? null,
            username: ssh.username,
            method: ssh.auth.method,
            keyPath: ssh.auth.keyPath ?? null,
            privateKey: ssh.auth.privateKey ?? null,
            passphrase: ssh.auth.passphrase ?? null,
            password: ssh.auth.password ?? null,
            knownHostsPath: ssh.knownHostsPath ?? null,
          },
  })
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 12)
}

interface CacheKeyParts {
  d: 'mysql' | 'postgresql' | 'sqlite'
  /** Server dialects: effective database. SQLite: realpath-resolved file. */
  t: string
  /** Spec fingerprint. */
  f: string
}

function encodeKey(parts: CacheKeyParts): string {
  return JSON.stringify(parts)
}

function decodeKey(key: string): CacheKeyParts | undefined {
  try {
    const parsed = JSON.parse(key) as Partial<CacheKeyParts> | null
    if (parsed === null || typeof parsed !== 'object') return undefined
    if (typeof parsed.d !== 'string' || typeof parsed.t !== 'string' || typeof parsed.f !== 'string') return undefined
    return parsed as CacheKeyParts
  } catch {
    return undefined
  }
}

async function endQuietly(entry: PoolEntry): Promise<void> {
  try {
    await entry.driver.end()
  } catch {
    /* closing a stale driver is best-effort */
  }
  if (entry.tunnel !== undefined) {
    try {
      await entry.tunnel.close()
    } catch {
      /* closing a stale tunnel is best-effort */
    }
  }
}

/** One cached driver plus the SSH tunnel (if any) that carries its traffic. */
interface PoolEntry {
  driver: DatabaseDriver
  tunnel?: SshTunnelHandle
}

export class PoolManager {
  /** connection name → inner key → entry (nested: no `::` prefix collisions, audit N5). */
  private readonly drivers = new Map<string, Map<string, PoolEntry>>()
  /** Pending creation promises keyed by name + inner key, so concurrent acquires coalesce. */
  private readonly inflight = new Map<string, Promise<PoolEntry>>()
  private readonly createDriver: DriverCreator

  /**
   * @param options.driverFactory override the default driver factory. Tests
   * pass a stub that avoids opening real network / file handles; the runtime
   * path leaves it undefined and uses the real drivers.
   */
  constructor(options?: { driverFactory?: DriverCreator }) {
    this.createDriver = options?.driverFactory ?? defaultDriverCreator
  }

  /** Return (or lazily create) the driver for this connection + database. */
  async acquire(spec: ConnectionSpec, options: PoolOptions, database?: string): Promise<DatabaseDriver> {
    // SQLite re-validation on every acquire (audit N3): the cache is shared
    // across sessions/workspaces, so a create-time-only check would let a
    // later caller bypass its own allowedRoots through a cache hit. This also
    // yields the realpath-resolved target that becomes part of the cache key,
    // so two workspaces resolving the same relative path never share a driver
    // pointing at the wrong file.
    let target: string
    if (spec.dialect === 'sqlite') {
      target = validateSqliteFilePath(spec.file ?? '', options.allowedRoots ?? [])
    } else {
      target = database ?? spec.defaultDatabase ?? ''
    }
    const fingerprint = specFingerprint(spec, options.sshProfile)
    let inner = this.drivers.get(spec.name)
    if (inner === undefined) {
      inner = new Map<string, PoolEntry>()
      this.drivers.set(spec.name, inner)
    }
    // Prune outdated entries: a changed spec (edited host/credentials/file,
    // audit N2) must not keep serving the previous driver — close it. A
    // retargeted symlink can change the sqlite realpath without changing the
    // fingerprint (same raw file string), so sqlite entries with a different
    // resolved target are pruned too (a sqlite connection has exactly one
    // file — unlike server dialects, which legitimately hold several
    // databases in parallel).
    for (const [key, entry] of inner) {
      const parts = decodeKey(key)
      const outdated =
        parts === undefined ||
        parts.f !== fingerprint ||
        (spec.dialect === 'sqlite' && parts.d === 'sqlite' && parts.t !== target)
      if (outdated) {
        inner.delete(key)
        void endQuietly(entry)
      }
    }
    const key = encodeKey({ d: spec.dialect, t: target, f: fingerprint })
    const cached = inner.get(key)
    if (cached !== undefined) return cached.driver
    const inflightKey = `${spec.name}\u241f${key}`
    const pending = this.inflight.get(inflightKey)
    if (pending !== undefined) return (await pending).driver
    const creation = this.createEntry(spec, options, database).then((entry) => {
      inner!.set(key, entry)
      return entry
    }).finally(() => {
      this.inflight.delete(inflightKey)
    })
    this.inflight.set(inflightKey, creation)
    return (await creation).driver
  }

  /**
   * Open the SSH tunnel (when configured) and the driver behind it. The
   * tunnel's local port replaces the configured host/port for the driver, so
   * the database sees a connection from the jump host.
   */
  private async createEntry(spec: ConnectionSpec, options: PoolOptions, database?: string): Promise<PoolEntry> {
    const ssh = options.sshProfile
    if (ssh === undefined || spec.dialect === 'sqlite') {
      return { driver: await this.createDriver(spec, options, database) }
    }
    if (spec.host === undefined || spec.port === undefined) {
      throw new Error(`连接 "${spec.name}" 配置了 SSH 隧道但缺少 host/port`)
    }
    const tunnel = await openSshTunnel({ profile: ssh, targetHost: spec.host, targetPort: spec.port })
    try {
      const tunnelled: ConnectionSpec = { ...spec, host: '127.0.0.1', port: tunnel.localPort }
      const driver = await this.createDriver(tunnelled, { ...options, sshProfile: undefined }, database)
      return { driver, tunnel }
    } catch (error) {
      await tunnel.close()
      throw error
    }
  }

  /** Close every driver (and tunnel) cached for one connection name (exact match, no prefix). */
  async close(name: string): Promise<void> {
    const inner = this.drivers.get(name)
    if (inner === undefined) return
    this.drivers.delete(name)
    await Promise.allSettled([...inner.values()].map((entry) => endQuietly(entry)))
  }

  async closeAll(): Promise<void> {
    const inners = [...this.drivers.values()]
    this.drivers.clear()
    this.inflight.clear()
    const all = inners.flatMap((inner) => [...inner.values()])
    await Promise.allSettled(all.map((entry) => endQuietly(entry)))
  }

  /** Close every driver (and tunnel) whose connection name disappeared from the config after a reload. */
  async retainOnly(validNames: ReadonlySet<string>): Promise<void> {
    const stale: PoolEntry[] = []
    for (const [name, inner] of this.drivers) {
      if (validNames.has(name)) continue
      this.drivers.delete(name)
      stale.push(...inner.values())
    }
    await Promise.allSettled(stale.map((entry) => endQuietly(entry)))
  }
}

/** Resolve and validate a SQLite file path against the allowed root list.
 *  Returns the realpath-resolved file (audit N3: junctions/symlinks inside an
 *  allowed root are resolved to their real target before the containment
 *  check, so a link cannot point outside the root while its path stays inside).
 *  Exported so the GUI save path and the pool cache can run the same check. */
export function validateSqliteFilePath(file: string, allowedRoots: ReadonlyArray<string>): string {
  if (file === ':memory:') return file
  if (allowedRoots.length === 0) {
    throw new Error('SQLite 连接必须配置在工作区目录或显式允许的根目录下；当前调用没有提供 allowedRoots 拒绝以防任意文件读取')
  }
  const resolved = path.resolve(file)
  let real = resolved
  try {
    real = fs.realpathSync(resolved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      // The file does not exist yet (first open may create it): realpath the
      // nearest existing ancestor so a symlinked directory chain still
      // resolves to its real location.
      try {
        real = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved))
      } catch {
        real = resolved
      }
    }
    // Other errors (e.g. permission) keep the resolved path: the open itself
    // will fail closed at the driver.
  }
  const roots = allowedRoots.map((r) => {
    const abs = path.resolve(r)
    try {
      return fs.realpathSync(abs)
    } catch {
      return abs
    }
  })
  const inside = roots.some((root) => real === root || real.startsWith(root + path.sep))
  if (!inside) {
    throw new Error(`SQLite 文件路径不在允许的根目录下（解析后: ${real}; 允许: ${roots.join(', ')}）`)
  }
  return real
}

/**
 * One-shot standalone connection used by connectivity tests (never pooled).
 * Honors a configured SSH profile: the probe opens its own tunnel so a test
 * exercises exactly the same path the pooled driver would take, and tears the
 * tunnel down together with the connection.
 */
export async function probeConnection(spec: ConnectionSpec, options: PoolOptions): Promise<{ latencyMs: number; close: () => Promise<void> }> {
  const ssh = options.sshProfile
  if (ssh === undefined || spec.dialect === 'sqlite') {
    return probeDirect(spec, options)
  }
  if (spec.host === undefined || spec.port === undefined) {
    throw new Error(`连接 "${spec.name}" 配置了 SSH 隧道但缺少 host/port`)
  }
  const tunnel = await openSshTunnel({ profile: ssh, targetHost: spec.host, targetPort: spec.port })
  try {
    const tunnelled: ConnectionSpec = { ...spec, host: '127.0.0.1', port: tunnel.localPort }
    const probe = await probeDirect(tunnelled, { ...options, sshProfile: undefined })
    return {
      latencyMs: probe.latencyMs,
      close: async () => {
        await probe.close().catch(() => undefined)
        await tunnel.close()
      },
    }
  } catch (error) {
    await tunnel.close()
    throw error
  }
}

async function probeDirect(spec: ConnectionSpec, options: PoolOptions): Promise<{ latencyMs: number; close: () => Promise<void> }> {
  if (spec.dialect === 'postgresql') {
    return probePgsql(spec, options)
  }
  if (spec.dialect === 'sqlite') {
    return probeSqlite(spec, options.allowedRoots)
  }
  return probeMysql(spec, options)
}

async function probeSqlite(spec: ConnectionSpec, allowedRoots: ReadonlyArray<string> | undefined): Promise<{ latencyMs: number; close: () => Promise<void> }> {
  if (spec.file === undefined || spec.file.length === 0) {
    throw new Error('SQLite 连接必须填写 file（数据库文件路径）')
  }
  // Probe always validates when allowedRoots are provided; when the GUI calls
  // the test without an explicit allow-list (shouldn't happen with the new
  // contract but keep the boundary tight) we still pass through.
  const driver = await SqliteDriver.create(spec, { connectTimeoutMs: 0, queryTimeoutMs: 0 }, { allowedRoots: allowedRoots ?? [] })
  const started = Date.now()
  try {
    await driver.query('SELECT 1', undefined)
  } catch (error) {
    await driver.end().catch(() => undefined)
    throw error
  }
  const latencyMs = Date.now() - started
  return { latencyMs, close: () => driver.end().catch(() => undefined) }
}

async function probeMysql(spec: ConnectionSpec, options: PoolOptions): Promise<{ latencyMs: number; close: () => Promise<void> }> {
  const ssl = spec.ssl?.enabled === true ? { rejectUnauthorized: spec.ssl.rejectUnauthorized ?? true } : undefined
  const connection = await mysql.createConnection({
    host: spec.host,
    port: spec.port,
    user: spec.username,
    password: spec.password,
    database: spec.defaultDatabase,
    connectTimeout: options.connectTimeoutMs,
    ...(ssl === undefined ? {} : { ssl }),
  } as mysql.ConnectionOptions)
  const started = Date.now()
  try {
    await connection.query('SELECT 1')
  } catch (error) {
    await connection.end().catch(() => undefined)
    throw error
  }
  const latencyMs = Date.now() - started
  return { latencyMs, close: () => connection.end().catch(() => undefined) }
}

async function probePgsql(spec: ConnectionSpec, options: PoolOptions): Promise<{ latencyMs: number; close: () => Promise<void> }> {
  const { Client } = await import('pg')
  const ssl = spec.ssl?.enabled === true ? { rejectUnauthorized: spec.ssl.rejectUnauthorized ?? true } : false
  const client = new (Client as unknown as new (config: Record<string, unknown>) => { connect(): Promise<void>; query(sql: string): Promise<unknown>; end(): Promise<void> })({
    host: spec.host,
    port: spec.port,
    user: spec.username,
    password: spec.password,
    database: spec.defaultDatabase,
    connectionTimeoutMillis: options.connectTimeoutMs,
    ssl,
  })
  await client.connect()
  const started = Date.now()
  try {
    await client.query('SELECT 1')
  } catch (error) {
    await client.end().catch(() => undefined)
    throw error
  }
  const latencyMs = Date.now() - started
  return { latencyMs, close: () => client.end().catch(() => undefined) }
}
