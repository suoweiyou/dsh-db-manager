import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import mysql from 'mysql2'
import { describe, expect, it } from 'vitest'
import { loadOrCreateKey, SecretError } from '../src/secrets.js'
import { quoteIdentifier } from '../src/tools/resolve.js'
import { PoolManager, validateSqliteFilePath } from '../src/db/pool.js'
import { connectionSchema } from '../src/config/schema.js'
import type { ConnectionSpec } from '../src/shared/types.js'
import type { DatabaseDriver } from '../src/db/dialect.js'
import { buildMysqlPoolOptions } from '../src/db/mysql-driver.js'
import { enforceReadLimit } from '../src/tools/data.js'

describe('mysql capability pins (v0.16 hardening)', () => {
  const spec: ConnectionSpec = {
    name: 'pin', dialect: 'mysql', host: 'h', port: 3306, username: 'u', password: '$ENV:P', mode: 'readonly',
  }
  const options = { connectTimeoutMs: 1000, queryTimeoutMs: 1000 }

  it('blacklists the LOCAL_FILES capability instead of the ignored localInfile option', () => {
    const built = buildMysqlPoolOptions(spec, options) as { flags?: string[]; localInfile?: unknown; multipleStatements?: unknown }
    expect(built.flags).toEqual(['-LOCAL_FILES'])
    // `localInfile` is not a mysql2 option at all (3.x ignores it with a
    // warning), so it must not be presented as the protective pin.
    expect(built.localInfile).toBeUndefined()
    expect(built.multipleStatements).toBe(false)
  })

  it('really clears the LOCAL_FILES client flag (behavioural check)', () => {
    const mysqlModule = mysql as unknown as { ConnectionConfig: new (o: Record<string, unknown>) => { clientFlags: number } }
    const built = buildMysqlPoolOptions(spec, options) as Record<string, unknown>
    const configured = new mysqlModule.ConnectionConfig(built)
    expect((configured.clientFlags & 0x00000080) !== 0).toBe(false)
    // Sanity: without the pin mysql2 would advertise the capability.
    const unpinned = new mysqlModule.ConnectionConfig({ host: 'h', user: 'u' })
    expect((unpinned.clientFlags & 0x00000080) !== 0).toBe(true)
  })

  it('refuses extraParams that try to re-enable capabilities via flags', () => {
    const parsed = connectionSchema.safeParse({
      name: 'evil', dialect: 'mysql', host: 'h', username: 'u', password: '$ENV:P',
      extraParams: { flags: 'LOCAL_FILES,MULTIPLE_STATEMENTS' },
    })
    expect(parsed.success).toBe(false)
  })

  it('keeps our pins even if a flags value reaches the driver (defense in depth)', () => {
    const built = buildMysqlPoolOptions(
      { ...spec, extraParams: { flags: 'LOCAL_FILES', timezone: 'Z' } },
      options,
    ) as Record<string, unknown>
    expect(built.flags).toEqual(['-LOCAL_FILES'])
    expect(built.timezone).toBe('Z')
  })
})

describe('loadOrCreateKey corruption guard', () => {
  it('refuses to silently rotate a corrupted key file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-key-'))
    const keyPath = path.join(dir, 'secret.key')
    fs.writeFileSync(keyPath, Buffer.from('short'))
    expect(() => loadOrCreateKey(keyPath)).toThrow(SecretError)
    // The corrupted file is left untouched (no silent rotation).
    expect(fs.readFileSync(keyPath).length).toBe(5)
  })

  it('creates a fresh 32-byte key when none exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-key-'))
    const keyPath = path.join(dir, 'secret.key')
    const key = loadOrCreateKey(keyPath)
    expect(key.length).toBe(32)
    expect(fs.readFileSync(keyPath).equals(key)).toBe(true)
  })
})

describe('quoteIdentifier', () => {
  it('accepts plain, unicode and $ identifiers for MySQL (backticks)', () => {
    expect(quoteIdentifier('mysql', 'users')).toBe('`users`')
    expect(quoteIdentifier('mysql', '订单表')).toBe('`订单表`')
    expect(quoteIdentifier('mysql', '$sys_name')).toBe('`$sys_name`')
  })

  it('accepts the same identifier set for PostgreSQL (double quotes)', () => {
    expect(quoteIdentifier('postgresql', 'users')).toBe('"users"')
    expect(quoteIdentifier('postgresql', '订单表')).toBe('"订单表"')
    expect(quoteIdentifier('postgresql', '$sys_name')).toBe('"$sys_name"')
  })

  it('accepts the same identifier set for SQLite (backticks, MySQL-compatible)', () => {
    expect(quoteIdentifier('sqlite', 'users')).toBe('`users`')
    expect(quoteIdentifier('sqlite', '订单表')).toBe('`订单表`')
    expect(quoteIdentifier('sqlite', '$sys_name')).toBe('`$sys_name`')
  })

  it('rejects identifiers with quotes, semicolons, spaces or control chars (any dialect)', () => {
    for (const dialect of ['mysql', 'postgresql', 'sqlite'] as const) {
      expect(() => quoteIdentifier(dialect, 'bad;name')).toThrow(/非法/)
      expect(() => quoteIdentifier(dialect, 'bad`name')).toThrow(/非法/)
      expect(() => quoteIdentifier(dialect, "bad'name")).toThrow(/非法/)
      expect(() => quoteIdentifier(dialect, 'bad"name')).toThrow(/非法/)
      expect(() => quoteIdentifier(dialect, 'bad name')).toThrow(/非法/)
      expect(() => quoteIdentifier(dialect, '')).toThrow(/非法/)
    }
  })
})

describe('PoolManager spec-fingerprint cache (audit N2)', () => {
  it('reuses the same driver for an unchanged spec', async () => {
    const { created, manager } = makePoolManager()
    const spec: ConnectionSpec = { name: 'a', dialect: 'mysql', host: 'h1', port: 3306, username: 'u', password: '$ENV:P', mode: 'readonly' }
    const first = await manager.acquire(spec, { connectTimeoutMs: 1, queryTimeoutMs: 1 })
    const second = await manager.acquire(spec, { connectTimeoutMs: 1, queryTimeoutMs: 1 })
    expect(second).toBe(first)
    expect(created).toHaveLength(1)
  })

  it('creates a fresh driver and closes the stale one when the spec changes (edited host/credentials)', async () => {
    const { created, closed, manager } = makePoolManager()
    const spec: ConnectionSpec = { name: 'prod', dialect: 'mysql', host: 'old-host', port: 3306, username: 'u', password: '$ENV:P', mode: 'readonly' }
    const oldDriver = await manager.acquire(spec, { connectTimeoutMs: 1, queryTimeoutMs: 1 })
    const edited: ConnectionSpec = { ...spec, host: 'new-host' }
    const newDriver = await manager.acquire(edited, { connectTimeoutMs: 1, queryTimeoutMs: 1 })
    expect(newDriver).not.toBe(oldDriver)
    expect(created).toHaveLength(2)
    expect(closed).toEqual([created[0]])
    // A further acquire with the edited spec is stable (no churn).
    const again = await manager.acquire(edited, { connectTimeoutMs: 1, queryTimeoutMs: 1 })
    expect(again).toBe(newDriver)
    expect(created).toHaveLength(2)
  })

  it('close(name) never closes a different connection whose name embeds it (audit N5)', async () => {
    const { created, closed, manager } = makePoolManager()
    const specA: ConnectionSpec = { name: 'a', dialect: 'mysql', host: 'h', port: 3306, username: 'u', password: '$ENV:P', mode: 'readonly' }
    const specAcolin: ConnectionSpec = { name: 'a::mysql', dialect: 'mysql', host: 'h2', port: 3306, username: 'u', password: '$ENV:P', mode: 'readonly' }
    const driverA = await manager.acquire(specA, { connectTimeoutMs: 1, queryTimeoutMs: 1 })
    const driverB = await manager.acquire(specAcolin, { connectTimeoutMs: 1, queryTimeoutMs: 1 })
    expect(driverA).not.toBe(driverB)
    await manager.close('a')
    expect(closed).toEqual([created[0]])
    const driverBAfter = await manager.acquire(specAcolin, { connectTimeoutMs: 1, queryTimeoutMs: 1 })
    expect(driverBAfter).toBe(driverB)
    expect(created).toHaveLength(2)
  })

  it('retainOnly closes pools of vanished names only', async () => {
    const { created, closed, manager } = makePoolManager()
    const specA: ConnectionSpec = { name: 'keep', dialect: 'mysql', host: 'h', port: 3306, username: 'u', password: '$ENV:P', mode: 'readonly' }
    const specB: ConnectionSpec = { name: 'gone', dialect: 'mysql', host: 'h', port: 3306, username: 'u', password: '$ENV:P', mode: 'readonly' }
    const driverA = await manager.acquire(specA, { connectTimeoutMs: 1, queryTimeoutMs: 1 })
    const driverB = await manager.acquire(specB, { connectTimeoutMs: 1, queryTimeoutMs: 1 })
    await manager.retainOnly(new Set(['keep']))
    expect(closed).toEqual([created[1]])
    expect(closed).not.toContain(created[0])
    // keep → still cached (no recreation); gone → recreated on demand.
    const keepAgain = await manager.acquire(specA, { connectTimeoutMs: 1, queryTimeoutMs: 1 })
    expect(keepAgain).toBe(driverA)
    expect(created).toHaveLength(2)
    const goneAgain = await manager.acquire(specB, { connectTimeoutMs: 1, queryTimeoutMs: 1 })
    expect(goneAgain).not.toBe(driverB)
    expect(created).toHaveLength(3)
    expect(closed).toEqual([created[1]])
  })
})

describe('SQLite acquire-time sandbox re-validation (audit N3)', () => {
  it('re-validates allowedRoots on a cache hit from a different workspace root', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-rootA-'))
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-rootB-'))
    const spec: ConnectionSpec = { name: 's', dialect: 'sqlite', file: path.join(rootA, 'data.db'), mode: 'readonly' }
    let creations = 0
    const manager = new PoolManager({
      driverFactory: async (): Promise<DatabaseDriver> => {
        creations += 1
        return {
          dialect: 'sqlite',
          query: async () => [],
          execute: async () => ({ affectedRows: 0, rows: [] }),
          end: async () => undefined,
          withTransaction: async (fn) => fn({} as DatabaseDriver),
        }
      },
    })
    // First workspace opens the file inside rootA — allowed, driver cached.
    await manager.acquire(spec, { connectTimeoutMs: 1, queryTimeoutMs: 1, allowedRoots: [rootA] })
    expect(creations).toBe(1)
    // A second workspace whose allowed root is rootB must be refused even
    // though the driver is already cached — validation runs on every acquire.
    // (Await the rejection explicitly: the vitest shim has no .rejects, and an
    // unhandled rejection would crash the whole runner.)
    let rejected: unknown
    try {
      await manager.acquire(spec, { connectTimeoutMs: 1, queryTimeoutMs: 1, allowedRoots: [rootB] })
    } catch (error) {
      rejected = error
    }
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).message).toContain('不在允许的根目录下')
    expect(creations).toBe(1)
    fs.rmSync(rootA, { recursive: true, force: true })
    fs.rmSync(rootB, { recursive: true, force: true })
  })

  it('validateSqliteFilePath resolves junction/symlink targets before the containment check (audit N3)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-sandbox-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-outside-'))
    const outsideDb = path.join(outside, 'secret.db')
    fs.writeFileSync(outsideDb, '')
    const link = path.join(root, 'link.db')
    try {
      fs.symlinkSync(outsideDb, link, 'file')
    } catch {
      // Symlink privileges unavailable (Windows without developer mode): skip.
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
      return
    }
    expect(() => validateSqliteFilePath(link, [root])).toThrow(/不在允许的根目录下/)
    // A plain file inside the root still resolves and is returned as real path.
    const inside = path.join(root, 'ok.db')
    fs.writeFileSync(inside, '')
    expect(validateSqliteFilePath(inside, [root])).toBe(fs.realpathSync(inside))
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })
})

describe('mysql pool options hardening (audit N1/N4)', () => {
  const spec: ConnectionSpec = { name: 'm', dialect: 'mysql', host: 'h', port: 3306, username: 'u', password: '$ENV:P', mode: 'readwrite' }
  const factoryOptions = { connectTimeoutMs: 1000, queryTimeoutMs: 15_000 }

  it('strips uri/connectionString from extraParams and pins multipleStatements/capabilities off', () => {
    const options = buildMysqlPoolOptions({ ...spec, extraParams: { timezone: '+08:00', uri: 'mysql://evil/db?multipleStatements=true', connectionString: 'mysql://evil/db' } }, factoryOptions)
    expect((options as Record<string, unknown>).timezone).toBe('+08:00')
    expect((options as Record<string, unknown>).uri).toBeUndefined()
    expect((options as Record<string, unknown>).connectionString).toBeUndefined()
    expect((options as Record<string, unknown>).multipleStatements).toBe(false)
    // v0.16: the effective pin is the LOCAL_FILES blacklist — `localInfile` is
    // not a mysql2 option and was silently ignored (see the capability suite).
    expect((options as Record<string, unknown>).flags).toEqual(['-LOCAL_FILES'])
    expect((options as Record<string, unknown>).host).toBe('h')
  })

  it('keeps connection identity and TLS after the extraParams spread', () => {
    const options = buildMysqlPoolOptions({ ...spec, ssl: { enabled: true, rejectUnauthorized: false } }, factoryOptions)
    expect((options as Record<string, unknown>).host).toBe('h')
    expect((options as Record<string, unknown>).ssl).toEqual({ rejectUnauthorized: false })
  })
})

describe('enforceReadLimit (audit N4: cap oversized LIMIT)', () => {
  it('appends LIMIT when the statement has none (null)', () => {
    const out = enforceReadLimit('SELECT * FROM t', null, 50)
    expect(out.text).toBe('SELECT * FROM t LIMIT 50')
    expect(out.injected).toBe(true)
  })

  it('wraps the statement when its own LIMIT exceeds the cap', () => {
    const out = enforceReadLimit('SELECT * FROM big LIMIT 99999999999', 99999999999, 200)
    // The original LIMIT is preserved inside the derived table; the outer
    // LIMIT is what actually caps the rows the driver buffers.
    expect(out.text).toBe('SELECT * FROM (SELECT * FROM big LIMIT 99999999999) AS __dbm_l LIMIT 200')
    expect(out.injected).toBe(true)
  })

  it('leaves statements with a small LIMIT and unreadable limits untouched', () => {
    expect(enforceReadLimit('SELECT * FROM t LIMIT 10', 10, 200)).toEqual({ text: 'SELECT * FROM t LIMIT 10', injected: false })
    expect(enforceReadLimit('SELECT * FROM t LIMIT 100', Number.NaN, 50)).toEqual({ text: 'SELECT * FROM t LIMIT 100', injected: false })
  })

  it('strips a trailing semicolon in both wrapped and appended forms', () => {
    expect(enforceReadLimit('SELECT 1;', null, 10).text).toBe('SELECT 1 LIMIT 10')
    expect(enforceReadLimit('SELECT 1;', 5000, 10).text).toBe('SELECT * FROM (SELECT 1) AS __dbm_l LIMIT 10')
  })
})

function makePoolManager(): { created: string[]; closed: string[]; manager: PoolManager } {
  const created: string[] = []
  const closed: string[] = []
  let seq = 0
  const manager = new PoolManager({
    driverFactory: async (spec: ConnectionSpec): Promise<DatabaseDriver> => {
      const id = `${spec.name}#${(seq += 1)}`
      created.push(id)
      return {
        dialect: spec.dialect,
        query: async () => [],
        execute: async () => ({ affectedRows: 0, rows: [] }),
        end: async () => {
          closed.push(id)
        },
        withTransaction: async (fn) => fn({} as DatabaseDriver),
      }
    },
  })
  return { created, closed, manager }
}
