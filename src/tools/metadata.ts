/** Metadata tools (M3): databases, tables, table structure/DDL — dialect-aware. */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describeTable as describeTableByDialect, listDatabases, listTables } from '../db/metadata.js'
import { toDbFailure } from '../db/errors.js'
import { resolvePassword } from '../secrets.js'
import { resolveTarget } from './resolve.js'
import { resolveSessionInfo } from './workspace.js'
import type { ToolDeps } from './index.js'
import type { DatabaseDriver } from '../db/dialect.js'

export interface OpenedPool {
  connectionName: string
  dialect: 'mysql' | 'postgresql' | 'sqlite'
  database: string | undefined
  /** Run one statement and return rows as plain objects. */
  query(sql: string, values?: unknown[]): Promise<Array<Record<string, unknown>>>
  /** Run one statement and return the raw driver result (rows or affected-rows summary). */
  run(sql: string, values?: unknown[]): Promise<unknown>
  /**
   * Run a callback inside a transaction. Statements issued through the
   * transaction driver passed to `fn` all join the same transaction;
   * any throw rolls back, normal return commits. The transaction driver
   * is released when `fn` returns or throws.
   */
  withTransaction<T>(fn: (tx: OpenedPool) => Promise<T>): Promise<T>
}

/** Resolve target + password and open (or reuse) the driver for it; records usage. */
export async function openPoolFor(
  deps: ToolDeps,
  session: { sessionId?: string; cwd?: string },
  connection: string | undefined,
  databaseOverride?: string,
  action?: string,
): Promise<{ pool?: OpenedPool; failure?: { kind: string; message: string; hint?: string } }> {
  const target = resolveTarget(deps.store, session.cwd, connection)
  if (target.failure !== undefined || target.spec === undefined) {
    return { failure: target.failure ?? { kind: 'config', message: '连接不存在' } }
  }
  const spec = target.spec
  const database = databaseOverride ?? spec.defaultDatabase
  try {
    // FR-13: the connection may reach the database through an SSH jump host.
    // A broken reference is a configuration failure — never fall through to a
    // direct connection attempt (that would silently bypass the tunnel).
    const load = deps.store.load(session.cwd)
    const ssh = spec.sshProfile === undefined ? {} : deps.store.resolveSshProfile(load, spec)
    if (ssh.error !== undefined) {
      return { failure: { kind: 'config', message: ssh.error, hint: '检查连接的 sshProfile 名称，或先定义对应的 SSH 配置（全局或项目配置文件中的 sshProfiles）' } }
    }
    // SQLite connections do not carry a password; the rest need the stored
    // secret resolved (env var or enc ciphertext) before the driver opens.
    const resolvedSpec = spec.dialect === 'sqlite'
      ? spec
      : { ...spec, password: resolvePassword(spec.password ?? '') }
    // SQLite file paths are sandboxed against the current workspace cwd
    // (audit H2): only files inside that root — or the literal `:memory:` —
    // are reachable through this driver.
    const allowedRoots: ReadonlyArray<string> = session.cwd !== undefined && session.cwd.length > 0
      ? [session.cwd]
      : []
    const driver = await deps.pools.acquire(
      resolvedSpec,
      {
        connectTimeoutMs: deps.connectTimeoutMs,
        queryTimeoutMs: deps.queryTimeoutMs,
        allowedRoots,
        ...(ssh.profile === undefined ? {} : { sshProfile: ssh.profile }),
      },
      databaseOverride,
    )
    deps.usage.record(spec.name, session.sessionId, session.cwd, action)
    return {
      pool: wrapDriver(driver, spec.dialect, spec.name, database),
    }
  } catch (error) {
    const failure = toDbFailure(error)
    return { failure: { kind: failure.kind, message: failure.message, hint: failure.hint } }
  }
}

/** Wrap a driver in a tool-friendly OpenedPool surface. */
function wrapDriver(driver: DatabaseDriver, dialect: 'mysql' | 'postgresql' | 'sqlite', connectionName: string, database: string | undefined): OpenedPool {
  return {
    connectionName,
    dialect,
    database,
    async query(sql: string, values?: unknown[]): Promise<Array<Record<string, unknown>>> {
      const rows = await driver.query(sql, values, undefined)
      return rows
    },
    async run(sql: string, values?: unknown[]): Promise<unknown> {
      // The historical contract: SELECT-shaped statements return the rowset;
      // write statements return the affected-rows header (mysql2 OkPacket,
      // pg Result). Both drivers do this through `execute` now; we keep the
      // historical "run returns rows for SELECT" branch by sniffing the verb.
      const verb = sql.trimStart().split(/\s+/, 1)[0]?.toUpperCase() ?? ''
      if (verb === 'SELECT' || verb === 'SHOW' || verb === 'DESC' || verb === 'DESCRIBE' || verb === 'EXPLAIN' || verb === 'WITH') {
        return driver.query(sql, values, undefined)
      }
      return driver.execute(sql, values, undefined)
    },
    withTransaction<T>(fn: (tx: OpenedPool) => Promise<T>): Promise<T> {
      return driver.withTransaction(async (txDriver) => fn(wrapDriver(txDriver, dialect, connectionName, database)))
    },
  }
}

export function buildMetadataTools(deps: ToolDeps): unknown[] {
  const listDatabasesTool = defineTool({
    name: 'db_list_databases',
    description: 'List the databases visible to a dsh-db-manager connection (MySQL or PostgreSQL). Omit the connection name to use the workspace default connection.',
    parameters: {
      connection: { type: 'string', description: 'Connection name from db_list_connections. Omit for the default connection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connection: { type: 'string', required: true },
          dialect: { type: 'string', required: true, enum: ['mysql', 'postgresql', 'sqlite'] },
          databases: { type: 'array', required: true, items: { type: 'string' } },
          failureMessage: { type: 'string' },
          failureHint: { type: 'string' },
        },
      } as const,
      render: (_args, value) => {
        if (value.failureMessage !== undefined) return [{ type: 'text', text: `查询失败：${value.failureMessage}${value.failureHint === undefined ? '' : `\n建议：${value.failureHint}`}` }]
        return [{ type: 'text', text: `连接 ${value.connection}（${value.dialect}）可见数据库（${value.databases.length}）：${value.databases.join('、')}` }]
      },
    },
    async execute(args, exec) {
      const session = resolveSessionInfo(exec)
      const wanted = typeof (args as { connection?: unknown })?.connection === 'string' ? (args as { connection: string }).connection : undefined
      const opened = await openPoolFor(deps, session, wanted, undefined, 'db_list_databases')
      if (opened.failure !== undefined || opened.pool === undefined) {
        const failure = opened.failure!
        return { connection: wanted ?? '(default)', dialect: 'mysql' as 'mysql' | 'postgresql' | 'sqlite', databases: [] as string[], failureMessage: failure.message, ...(failure.hint === undefined ? {} : { failureHint: failure.hint }) }
      }
      try {
        const databases = await listDatabases(opened.pool)
        return { connection: opened.pool.connectionName, dialect: opened.pool.dialect, databases }
      } catch (error) {
        const failure = toDbFailure(error)
        return { connection: opened.pool.connectionName, dialect: opened.pool.dialect, databases: [] as string[], failureMessage: failure.message, ...(failure.hint === undefined ? {} : { failureHint: failure.hint }) }
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `列出数据库${typeof args?.connection === 'string' ? `（${args.connection}）` : ''}`, kind: 'read' }),
    isConcurrencySafe: () => true,
    timeoutMs: 20_000,
  })

  const listTablesTool = defineTool({
    name: 'db_list_tables',
    description: 'List tables and views of one database through a dsh-db-manager connection (MySQL or PostgreSQL), with type and (MySQL) comment + row-count estimate. Uses the connection default database when database is omitted.',
    parameters: {
      connection: { type: 'string', description: 'Connection name from db_list_connections. Omit for the default connection.' },
      database: { type: 'string', description: 'Database (schema) name. Omit to use the connection default database.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connection: { type: 'string', required: true },
          dialect: { type: 'string', required: true, enum: ['mysql', 'postgresql', 'sqlite'] },
          database: { type: 'string', required: true },
          tables: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', required: true },
                comment: { type: 'string' },
                rowsEstimate: { type: 'integer' },
              },
            },
          },
          failureMessage: { type: 'string' },
          failureHint: { type: 'string' },
        },
      } as const,
      render: (_args, value) => {
        if (value.failureMessage !== undefined) return [{ type: 'text', text: `查询失败：${value.failureMessage}${value.failureHint === undefined ? '' : `\n建议：${value.failureHint}`}` }]
        const lines = value.tables.map((t: { type: string; name: string; comment?: string }) => `- ${t.name}（${t.type === 'VIEW' ? '视图' : t.type === 'BASE TABLE' ? '表' : '表'}${t.comment === undefined || t.comment.length === 0 ? '' : `：${t.comment}`}）`)
        if (lines.length === 0) lines.push('（该库没有表或视图）')
        return [{ type: 'text', text: `连接 ${value.connection} · 库 ${value.database}：\n${lines.join('\n')}` }]
      },
    },
    async execute(args, exec) {
      const session = resolveSessionInfo(exec)
      const record = (args ?? {}) as { connection?: unknown; database?: unknown }
      const wanted = typeof record.connection === 'string' ? record.connection : undefined
      const database = typeof record.database === 'string' && record.database.length > 0 ? record.database : undefined
      const opened = await openPoolFor(deps, session, wanted, database, 'db_metadata')
      if (opened.failure !== undefined || opened.pool === undefined) {
        const failure = opened.failure!
        return { connection: wanted ?? '(default)', dialect: 'mysql' as 'mysql' | 'postgresql' | 'sqlite', database: database ?? '(default)', tables: [], failureMessage: failure.message, ...(failure.hint === undefined ? {} : { failureHint: failure.hint }) }
      }
      const pool = opened.pool
      if (pool.database === undefined) {
        return { connection: pool.connectionName, dialect: pool.dialect, database: '(未指定)', tables: [], failureMessage: '未指定 database 且连接未配置默认库', failureHint: '在参数中传入 database，或在连接配置中设置 defaultDatabase' }
      }
      try {
        const tables = await listTables(pool, pool.database)
        return { connection: pool.connectionName, dialect: pool.dialect, database: pool.database, tables }
      } catch (error) {
        const failure = toDbFailure(error)
        return { connection: pool.connectionName, dialect: pool.dialect, database: pool.database, tables: [], failureMessage: failure.message, ...(failure.hint === undefined ? {} : { failureHint: failure.hint }) }
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `列出数据表${typeof args?.database === 'string' ? `（${args.database}）` : ''}`, kind: 'read' }),
    isConcurrencySafe: () => true,
    timeoutMs: 20_000,
  })

  const describeTableTool = defineTool({
    name: 'db_describe_table',
    description: 'Describe one table through a dsh-db-manager connection (MySQL or PostgreSQL): columns (type/null/default/key/comment), indexes, and a best-effort DDL. Uses the connection default database when database is omitted.',
    parameters: {
      connection: { type: 'string', description: 'Connection name from db_list_connections. Omit for the default connection.' },
      database: { type: 'string', description: 'Database (schema) name. Omit to use the connection default database.' },
      table: { type: 'string', required: true, description: 'Table name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connection: { type: 'string', required: true },
          dialect: { type: 'string', required: true, enum: ['mysql', 'postgresql', 'sqlite'] },
          database: { type: 'string', required: true },
          table: { type: 'string', required: true },
          columns: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                columnType: { type: 'string', required: true },
                nullable: { type: 'string', required: true },
                defaultValue: { type: 'string' },
                key: { type: 'string' },
                extra: { type: 'string' },
                comment: { type: 'string' },
              },
            },
          },
          indexes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                unique: { type: 'boolean', required: true },
                columns: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          ddl: { type: 'string' },
          failureMessage: { type: 'string' },
          failureHint: { type: 'string' },
        },
      } as const,
      render: (_args, value) => {
        if (value.failureMessage !== undefined) return [{ type: 'text', text: `查询失败：${value.failureMessage}${value.failureHint === undefined ? '' : `\n建议：${value.failureHint}`}` }]
        const lines = value.columns.map((c: { name: string; columnType: string; nullable: string; key?: string; comment?: string }) =>
          `- ${c.name} ${c.columnType}${c.nullable === 'NO' ? ' NOT NULL' : ''}${c.key === undefined || c.key.length === 0 ? '' : ` [${c.key}]`}${c.comment === undefined || c.comment.length === 0 ? '' : ` —— ${c.comment}`}`,
        )
        const indexLines = value.indexes.map((idx: { name: string; unique: boolean; columns: string[] }) => `  · ${idx.name}${idx.unique ? '（唯一）' : ''}: ${idx.columns.join(', ')}`)
        const ddlLine = value.ddl === undefined ? '' : `\nDDL：\n${value.ddl}`
        return [{ type: 'text', text: `${value.connection} · ${value.database}.${value.table}（${value.columns.length} 列）：\n${lines.join('\n')}${indexLines.length > 0 ? `\n索引：\n${indexLines.join('\n')}` : ''}${ddlLine}` }]
      },
    },
    async execute(args, exec) {
      const session = resolveSessionInfo(exec)
      const record = (args ?? {}) as { connection?: unknown; database?: unknown; table?: unknown }
      const wanted = typeof record.connection === 'string' ? record.connection : undefined
      const database = typeof record.database === 'string' && record.database.length > 0 ? record.database : undefined
      const table = typeof record.table === 'string' && record.table.length > 0 ? record.table : ''
      const base = { connection: wanted ?? '(default)', dialect: 'mysql' as 'mysql' | 'postgresql' | 'sqlite', database: database ?? '(default)', table }
      if (table.length === 0) return { ...base, columns: [], indexes: [], failureMessage: '缺少 table 参数', failureHint: '传入要查看的表名' }
      const opened = await openPoolFor(deps, session, wanted, database, 'db_metadata')
      if (opened.failure !== undefined || opened.pool === undefined) {
        const failure = opened.failure!
        return { ...base, columns: [], indexes: [], failureMessage: failure.message, ...(failure.hint === undefined ? {} : { failureHint: failure.hint }) }
      }
      const pool = opened.pool
      base.dialect = pool.dialect
      if (pool.database === undefined) {
        return { ...base, database: '(未指定)', columns: [], indexes: [], failureMessage: '未指定 database 且连接未配置默认库', failureHint: '在参数中传入 database，或在连接配置中设置 defaultDatabase' }
      }
      try {
        const result = await describeTableByDialect(pool, pool.database, table)
        if (result === null) {
          return { ...base, database: pool.database, columns: [], indexes: [], failureMessage: `表 ${table} 不存在（或无权限查看）`, failureHint: '用 db_list_tables 核对表名' }
        }
        return { ...base, database: pool.database, columns: result.columns, indexes: result.indexes, ...(result.ddl === undefined ? {} : { ddl: result.ddl }) }
      } catch (error) {
        const failure = toDbFailure(error)
        return { ...base, database: pool.database, columns: [], indexes: [], failureMessage: failure.message, ...(failure.hint === undefined ? {} : { failureHint: failure.hint }) }
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `查看表结构（${typeof args?.table === 'string' ? args.table : '?'}）`, kind: 'read' }),
    isConcurrencySafe: () => true,
    timeoutMs: 30_000,
  })

  return [listDatabasesTool, listTablesTool, describeTableTool]
}
