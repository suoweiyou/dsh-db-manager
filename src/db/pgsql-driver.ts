/**
 * PostgreSQL driver: thin wrapper around `pg` that exposes DatabaseDriver.
 *
 * Two differences from the MySQL driver the rest of the plugin has to know
 * about, both isolated here so callers do not branch on dialect:
 *   1. Parameter placeholders are `$1, $2, …`, not `?`. We rewrite `?`→`$N`
 *      on every statement that carries values so the call sites keep using
 *      the familiar mysql2-style `?` placeholders.
 *   2. Pool options: `pg.Pool` uses `connectionString`-style or field form,
 *      supports TLS via the `ssl` field, and has its own pool/timeout knobs.
 *      We pin equivalent defaults to the MySQL side for predictable behavior.
 */
import { Pool as PgPool, type PoolConfig } from 'pg'
import type { ConnectionSpec } from '../shared/types.js'
import type { DatabaseDriver, DriverFactoryOptions, ExecuteResult, Row } from './dialect.js'

/** Driver-level options that extraParams must never override (parallels the MySQL set). */
const FORBIDDEN_PG_KEYS = new Set([
  'host',
  'port',
  'user',
  'password',
  'database',
  'ssl',
  'connectionstring',
  // Audit N1 (2nd round): kept out of extraParams for symmetry with the MySQL
  // driver — pg itself only honours `connectionString`, but banning both forms
  // keeps the denylist uniform and future-proof.
  'uri',
  'statement_timeout',
  'query_timeout',
  'lock_timeout',
  'idle_in_transaction_session_timeout',
])

function toPgConfig(spec: ConnectionSpec, options: DriverFactoryOptions, database?: string): PoolConfig {
  const ssl = spec.ssl?.enabled === true ? { rejectUnauthorized: spec.ssl.rejectUnauthorized ?? true } : false
  // extraParams spread FIRST so connection identity, TLS and timeout knobs
  // below always win — same defense-in-depth rationale as the MySQL driver.
  const extra = { ...(spec.extraParams ?? {}) as Record<string, string> }
  // Audit N1 (2nd round): strip URI entry points defensively so even an
  // unvalidated config cannot smuggle a connectionString past the denylist.
  delete extra.uri
  delete extra.connectionString
  for (const key of Object.keys(extra)) {
    if (FORBIDDEN_PG_KEYS.has(key.toLowerCase())) {
      throw new Error(`extraParams 禁止覆盖安全相关驱动选项（${key}）`)
    }
  }
  const config: PoolConfig = {
    ...extra,
    host: spec.host,
    port: spec.port,
    user: spec.username,
    password: spec.password,
    database: database ?? spec.defaultDatabase,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: options.connectTimeoutMs,
    // pg enforces query timeout via statement_timeout / query_timeout. Use
    // statement_timeout so it travels with the connection and survives pooled
    // reuse — same effective ceiling as mysql2's `timeout` knob.
    statement_timeout: options.queryTimeoutMs,
    ssl,
  }
  return config
}

/**
 * Replace every top-level `?` placeholder with a `$N` positional marker. The
 * rewrite is intentionally simple: every `?` outside of a string literal or
 * line comment is replaced in order. This is safe because the plugin never
 * builds SQL by string concatenation — values are always passed via the
 * `values` array, and identifiers go through the validator in tools/resolve.
 */
export function pgsqlPlaceholderRewrite(sql: string): string {
  let result = ''
  let index = 0
  let counter = 0
  while (index < sql.length) {
    const char = sql[index]
    if (char === "'" || char === '"') {
      const quote = char
      result += char
      index += 1
      while (index < sql.length) {
        const inner = sql[index]
        result += inner
        if (inner === '\\' && quote !== '"') {
          index += 1
          if (index < sql.length) result += sql[index]
          index += 1
          continue
        }
        if (inner === quote) {
          if (sql[index + 1] === quote) {
            result += quote
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (char === '-' && sql[index + 1] === '-') {
      while (index < sql.length && sql[index] !== '\n') {
        result += sql[index]
        index += 1
      }
      continue
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      const stop = end === -1 ? sql.length : end + 2
      result += sql.slice(index, stop)
      index = stop
      continue
    }
    if (char === '?') {
      counter += 1
      result += `$${counter}`
      index += 1
      continue
    }
    result += char
    index += 1
  }
  return result
}

export class PgsqlDriver implements DatabaseDriver {
  readonly dialect = 'postgresql' as const
  constructor(private readonly pool: PgPool) {}

  static create(spec: ConnectionSpec, options: DriverFactoryOptions, database?: string): PgsqlDriver {
    const pool = new PgPool(toPgConfig(spec, options, database))
    return new PgsqlDriver(pool)
  }

  async query(sql: string, values?: unknown[], _timeoutMs?: number): Promise<Row[]> {
    // statement_timeout on the session is set in toPgConfig; pg honours it.
    const text = values !== undefined ? pgsqlPlaceholderRewrite(sql) : sql
    const res = await this.pool.query({ text, values: values ?? [] })
    return res.rows as Row[]
  }

  async execute(sql: string, values?: unknown[], _timeoutMs?: number): Promise<ExecuteResult> {
    const text = values !== undefined ? pgsqlPlaceholderRewrite(sql) : sql
    const res = await this.pool.query({ text, values: values ?? [] })
    // pg has no native INSERT_ID; callers that need it should use RETURNING.
    const rows = res.rows as Row[]
    return { affectedRows: res.rowCount ?? 0, rows }
  }

  end(): Promise<void> {
    return this.pool.end()
  }

  /**
   * Run `fn` inside a PostgreSQL transaction. PG does NOT auto-begin on the
   * first query, so we issue an explicit `BEGIN` then run `fn` on the same
   * client. DDL inside `fn` stays inside the transaction (PG doesn't have
   * MySQL's implicit-commit-on-DDL behaviour).
   */
  async withTransaction<T>(fn: (tx: DatabaseDriver) => Promise<T>): Promise<T> {
    type PgClient = {
      query: (text: string, values?: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>
      release: (err?: Error) => void
    }
    const client = (await this.pool.connect()) as unknown as PgClient
    const tx: DatabaseDriver = {
      dialect: this.dialect,
      query: async (sql, values) => {
        const res = await client.query(sql, values ?? [])
        return res.rows
      },
      execute: async (sql, values) => {
        const res = await client.query(sql, values ?? [])
        return { affectedRows: res.rowCount ?? 0, rows: res.rows }
      },
      end: async () => undefined,  // release happens in finally below
      withTransaction: () => { throw new Error('嵌套事务不支持 — withTransaction 内部不能再开一个事务') },
    }
    try {
      await client.query('BEGIN')
      const result = await fn(tx)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

export const FORBIDDEN_PG_EXTRA_PARAMS = FORBIDDEN_PG_KEYS
