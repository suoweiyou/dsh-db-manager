/** MySQL driver: thin wrapper around mysql2/promise that exposes DatabaseDriver. */
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise'
import type { ConnectionSpec } from '../shared/types.js'
import type { DatabaseDriver, DriverFactoryOptions, ExecuteResult, Row } from './dialect.js'

const FORBIDDEN_MYSQL_KEYS = new Set([
  'host',
  'port',
  'user',
  'password',
  'database',
  'socketpath',
  'ssl',
  'multiplestatements',
  'stream',
  'localinfile',
  'infilestreamfactory',
  'authswitchhandler',
  // v0.16 hardening: `flags` is a second, independent way to switch client
  // capabilities on (mysql2 merges the user flag string into its defaults), so
  // allowing it through extraParams would re-enable LOCAL_FILES — and, worse,
  // MULTIPLE_STATEMENTS, which the single-statement safety gateway relies on
  // the driver refusing. The plugin sets its own flag string below.
  'flags',
])

function toMysqlOptions(spec: ConnectionSpec, options: DriverFactoryOptions, database?: string): mysql.PoolOptions {
  const ssl = spec.ssl?.enabled === true ? { rejectUnauthorized: spec.ssl.rejectUnauthorized ?? true } : undefined
  const extra = { ...(spec.extraParams ?? {}) }
  // Audit N1 (2nd round): defense-in-depth beyond the schema denylist. mysql2's
  // ConnectionConfig merges URI-derived options (including query-string flags
  // such as multipleStatements / localInfile / ssl) for every key that is not
  // pre-set, so a smuggled `uri` value would re-enable them at the driver even
  // though the config schema rejects the key. Strip the URI entry points here
  // and hard-pin the two options the single-statement safety gateway relies on.
  delete extra.uri
  delete extra.connectionString
  delete extra.Uri
  return {
    // extraParams spread FIRST: connection identity, pool policy and TLS
    // below always win, so extraParams can only tune harmless options
    // (timezone/charset/...) and never override security-relevant ones (audit M6).
    ...extra,
    multipleStatements: false,
    // v0.16 hardening: `localInfile: false` is NOT a mysql2 option — 3.x ignores
    // it with "Ignoring invalid configuration option" (observed live), so it
    // never removed anything. The effective pin is to blacklist the LOCAL_FILES
    // client capability: mysql2's default flags include LOCAL_FILES (0x80) and
    // `-LOCAL_FILES` clears it (verified against mysql2's ConnectionConfig).
    // mysql2 additionally fails closed (it refuses to read a local path when no
    // infileStreamFactory is configured), so this is defense in depth.
    flags: ['-LOCAL_FILES'],
    host: spec.host,
    port: spec.port,
    user: spec.username,
    password: spec.password,
    database: database ?? spec.defaultDatabase,
    connectionLimit: 5,
    maxIdle: 2,
    idleTimeout: 30_000,
    enableKeepAlive: true,
    connectTimeout: options.connectTimeoutMs,
    ...(ssl === undefined ? {} : { ssl }),
  } as mysql.PoolOptions
}

export class MysqlDriver implements DatabaseDriver {
  readonly dialect = 'mysql' as const
  private readonly queryTimeoutMs: number
  constructor(private readonly pool: Pool, queryTimeoutMs: number) {
    this.queryTimeoutMs = queryTimeoutMs
  }

  static create(spec: ConnectionSpec, options: DriverFactoryOptions, database?: string): MysqlDriver {
    const pool = mysql.createPool(toMysqlOptions(spec, options, database))
    return new MysqlDriver(pool, options.queryTimeoutMs)
  }

  async query(sql: string, values?: unknown[], timeoutMs?: number): Promise<Row[]> {
    const [rows] = await this.pool.query({
      sql,
      ...(values === undefined ? {} : { values }),
      // Audit N4 (2nd round): the driver stores queryTimeoutMs from the pool
      // options so every statement gets the configured ceiling even when the
      // caller does not pass a per-call timeout. mysql2's timeout is a
      // client-side inactivity timeout — it does not stop server-side
      // execution (audit M7), but it bounds how long the host waits.
      timeout: timeoutMs ?? this.queryTimeoutMs,
    })
    return Array.isArray(rows) ? (rows as RowDataPacket[] as Row[]) : []
  }

  async execute(sql: string, values?: unknown[], timeoutMs?: number): Promise<ExecuteResult> {
    const [result] = await this.pool.query({
      sql,
      ...(values === undefined ? {} : { values }),
      timeout: timeoutMs ?? this.queryTimeoutMs,
    })
    if (Array.isArray(result)) {
      return { affectedRows: 0, rows: result as RowDataPacket[] as Row[] }
    }
    const header = result as { affectedRows?: number; insertId?: number }
    const affected = typeof header.affectedRows === 'number' ? header.affectedRows : 0
    const insertId = typeof header.insertId === 'number' && header.insertId > 0 ? header.insertId : undefined
    return { affectedRows: affected, ...(insertId === undefined ? {} : { insertId }), rows: [] }
  }

  end(): Promise<void> {
    return this.pool.end()
  }

  /**
   * Run `fn` inside a MySQL transaction. We acquire a dedicated connection
   * from the pool (mysql2 implicitly starts a transaction on every query
   * until commit/rollback), then route `tx` calls through that connection so
   * every statement joins the same transaction. DDL issued inside `fn` will
   * implicitly commit on InnoDB — callers that need atomic DDL must issue
   * those statements outside withTransaction.
   */
  async withTransaction<T>(fn: (tx: DatabaseDriver) => Promise<T>): Promise<T> {
    // mysql2/promise: pull a dedicated connection from the pool so we can
    // beginTransaction / commit / rollback on it without affecting other
    // pool users.
    type Conn = {
      beginTransaction: () => Promise<void>
      commit: () => Promise<void>
      rollback: () => Promise<void>
      release: () => void
      query: (opts: { sql: string; values?: unknown[]; timeout?: number }) => Promise<unknown[]>
    }
    const poolAny = this.pool as unknown as { getConnection: () => Promise<Conn> }
    const conn = await poolAny.getConnection()
    const tx: DatabaseDriver = {
      dialect: this.dialect,
      query: async (sql, values, timeoutMs) => {
        const [rows] = await conn.query({ sql, ...(values === undefined ? {} : { values }), timeout: timeoutMs ?? this.queryTimeoutMs })
        return Array.isArray(rows) ? (rows as Row[]) : []
      },
      execute: async (sql, values, timeoutMs) => {
        const [result] = await conn.query({ sql, ...(values === undefined ? {} : { values }), timeout: timeoutMs ?? this.queryTimeoutMs })
        if (Array.isArray(result)) return { affectedRows: 0, rows: result as Row[] }
        const header = result as { affectedRows?: number; insertId?: number }
        const affected = typeof header.affectedRows === 'number' ? header.affectedRows : 0
        const insertId = typeof header.insertId === 'number' && header.insertId > 0 ? header.insertId : undefined
        return { affectedRows: affected, ...(insertId === undefined ? {} : { insertId }), rows: [] }
      },
      end: async () => undefined,  // release happens in finally below; tx.end() is a no-op
      withTransaction: () => { throw new Error('嵌套事务不支持 — withTransaction 内部不能再开一个事务') },
    }
    try {
      await conn.beginTransaction()
      const result = await fn(tx)
      await conn.commit()
      return result
    } catch (error) {
      await conn.rollback().catch(() => undefined)
      throw error
    } finally {
      conn.release()
    }
  }
}

export const FORBIDDEN_MYSQL_EXTRA_PARAMS = FORBIDDEN_MYSQL_KEYS

/** Exposed for tests: verify the extraParams/URI hardening and pinned options. */
export function buildMysqlPoolOptions(spec: ConnectionSpec, options: DriverFactoryOptions, database?: string): mysql.PoolOptions {
  return toMysqlOptions(spec, options, database)
}
