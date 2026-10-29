/**
 * Dialect-aware metadata queries: list databases, list tables, describe a
 * table (columns / indexes / DDL). The driver surface stays uniform; only the
 * SQL itself branches on dialect because that is the surface the database
 * understands. Keeping the per-dialect logic here means tools/metadata.ts
 * never branches on dialect and never sees mysql2 / pg specifics.
 */
import type { DialectId } from '../shared/types.js'
import type { Row } from './dialect.js'
import { quoteIdentifier } from '../tools/resolve.js'

/** Read-only surface the metadata functions need from a driver. */
export interface QueryOnlyDriver {
  readonly dialect: DialectId
  query(sql: string, values?: unknown[]): Promise<Row[]>
}

export interface TableInfo {
  name: string
  type: string
  comment?: string
  rowsEstimate?: number
}

export interface ColumnInfo {
  name: string
  columnType: string
  nullable: string
  defaultValue?: string
  key?: string
  extra?: string
  comment?: string
}

export interface IndexInfo {
  name: string
  unique: boolean
  columns: string[]
}

export interface DescribeResult {
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  ddl?: string
}

/* ── list databases ───────────────────────────────────────────────────────── */

export async function listDatabases(driver: QueryOnlyDriver): Promise<string[]> {
  if (driver.dialect === 'postgresql') {
    // pg_database holds every database visible to the cluster; template DBs are
    // not user-facing, so we filter them out (mirrors MySQL's SHOW DATABASES
    // which already excludes information_schema / performance_schema from the
    // user's perspective only when privileges are absent).
    const rows = await driver.query(
      "SELECT datname AS name FROM pg_database WHERE NOT datistemplate ORDER BY datname",
    )
    return rows.map((row) => String(row['name'] ?? '')).filter((s) => s.length > 0)
  }
  if (driver.dialect === 'sqlite') {
    // A single SQLite file is one database. PRAGMA database_list reports the
    // main database plus any attached ones; return their `name` values.
    const rows = await driver.query('PRAGMA database_list', [])
    return rows.map((row) => String(row['name'] ?? '')).filter((s) => s.length > 0)
  }
  const rows = await driver.query('SHOW DATABASES')
  return rows.map((row) => String((row as Row)['Database'] ?? (row as Row)['database'] ?? '')).filter((s) => s.length > 0)
}

/* ── PostgreSQL schema resolution ─────────────────────────────────────────── */

/**
 * PostgreSQL has an extra layer that MySQL lacks: 数据库(database) →
 * 模式(schema) → 表. The connection's `defaultDatabase` names the DATABASE
 * the connection is bound to, NOT the schema whose tables the caller wants
 * (which is almost always `public`). Feeding the database name straight into
 * `information_schema.tables WHERE table_schema = $1` yields an empty list —
 * the exact "PG 查不到表, MySQL 可以" report.
 *
 * Resolution rule (kept pure for tests):
 *   - empty parameter            → the caller never meant a schema → `public`
 *   - parameter == current DB    → again the DATABASE role → `public`
 *   - otherwise                  → treated as an explicit schema name
 *
 * An explicitly-passed schema (`db_list_tables { database: 'other_schema' }`)
 * keeps working unchanged.
 */
export function resolvePgSchemaValue(database: string | undefined, currentDatabase: string | undefined): string {
  const trimmed = (database ?? '').trim()
  if (trimmed === '') return 'public'
  if (currentDatabase !== undefined && trimmed === currentDatabase) return 'public'
  return trimmed
}

/** Resolve the effective schema for one PG metadata call (queries current_database()). */
export async function resolvePgSchema(driver: QueryOnlyDriver, database: string | undefined): Promise<string> {
  const rows = await driver.query('SELECT current_database() AS db')
  const current = rows[0]?.['db']
  return resolvePgSchemaValue(database, typeof current === 'string' && current.length > 0 ? current : undefined)
}

/* ── list tables ──────────────────────────────────────────────────────────── */

export async function listTables(driver: QueryOnlyDriver, database: string): Promise<TableInfo[]> {
  if (driver.dialect === 'postgresql') {
    // `database` here is the SCHEMA role (see resolvePgSchema); the DATABASE
    // role of the connection is honored at connect time via the pg driver.
    const schema = await resolvePgSchema(driver, database)
    const rows = await driver.query(
      `SELECT table_name AS name, table_type AS type
         FROM information_schema.tables
         WHERE table_schema = $1
         ORDER BY table_name`,
      [schema],
    )
    return rows.map((row) => {
      const rawType = String(row['type'] ?? '')
      const normalized = rawType === 'BASE TABLE' ? 'TABLE' : rawType
      return { name: String(row['name'] ?? ''), type: normalized }
    })
  }
  if (driver.dialect === 'sqlite') {
    // sqlite_master lists every table/view/index/trigger; filter to the two
    // we expose and skip sqlite-internal names. The `database` parameter is
    // honored for parity with the other dialects but SQLite only honors
    // `main`/`temp`/attached names; we accept the caller's value as a
    // documentation signal and route to sqlite_master regardless.
    void database
    const rows = await driver.query(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      [],
    )
    return rows.map((row) => ({ name: String(row['name'] ?? ''), type: String(row['type'] ?? '') }))
  }
  const rows = await driver.query(
    'SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_COMMENT AS comment, TABLE_ROWS AS rowsEstimate ' +
      'FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    [database],
  )
  return rows.map((row) => {
    const comment = typeof row['comment'] === 'string' && row['comment'].length > 0 ? row['comment'] : undefined
    const rowsEstimate = typeof row['rowsEstimate'] === 'number' ? row['rowsEstimate'] : undefined
    return {
      name: String(row['name'] ?? ''),
      type: String(row['type'] ?? ''),
      ...(comment === undefined ? {} : { comment }),
      ...(rowsEstimate === undefined ? {} : { rowsEstimate }),
    }
  })
}

/* ── describe table ───────────────────────────────────────────────────────── */

export async function describeTable(driver: QueryOnlyDriver, database: string, table: string): Promise<DescribeResult | null> {
  if (driver.dialect === 'postgresql') {
    return describePgsql(driver, database, table)
  }
  if (driver.dialect === 'sqlite') {
    return describeSqlite(driver, table)
  }
  return describeMysql(driver, database, table)
}

async function describeMysql(driver: QueryOnlyDriver, database: string, table: string): Promise<DescribeResult | null> {
  const columnRows = await driver.query(
    'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue, ' +
      'COLUMN_KEY AS `key`, EXTRA AS extra, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [database, table],
  )
  if (columnRows.length === 0) return null
  const columns: ColumnInfo[] = columnRows.map((row) => ({
    name: String(row['name'] ?? ''),
    columnType: String(row['columnType'] ?? ''),
    nullable: String(row['nullable'] ?? ''),
    ...(row['defaultValue'] === null || row['defaultValue'] === undefined ? {} : { defaultValue: String(row['defaultValue']) }),
    ...(row['key'] === null || row['key'] === undefined || String(row['key']).length === 0 ? {} : { key: String(row['key']) }),
    ...(row['extra'] === null || row['extra'] === undefined || String(row['extra']).length === 0 ? {} : { extra: String(row['extra']) }),
    ...(typeof row['comment'] === 'string' && row['comment'].length > 0 ? { comment: row['comment'] } : {}),
  }))
  const indexRows = await driver.query(
    'SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS column_ ' +
      'FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
    [database, table],
  )
  const grouped = new Map<string, IndexInfo>()
  for (const row of indexRows) {
    const name = String(row['name'] ?? '')
    const entry = grouped.get(name) ?? { name, unique: Number(row['nonUnique']) === 0, columns: [] }
    entry.columns.push(String(row['column_'] ?? ''))
    grouped.set(name, entry)
  }
  let ddl: string | undefined
  try {
    const ddlRows = await driver.query(`SHOW CREATE TABLE ${quoteIdentifier('mysql', database)}.${quoteIdentifier('mysql', table)}`)
    const first = ddlRows[0]
    const text = (first?.['Create Table'] ?? first?.['Create View']) as string | undefined
    if (typeof text === 'string') ddl = text
  } catch {
    /* DDL is best-effort */
  }
  return { columns, indexes: [...grouped.values()], ...(ddl === undefined ? {} : { ddl }) }
}

async function describePgsql(driver: QueryOnlyDriver, database: string, table: string): Promise<DescribeResult | null> {
  // Same DATABASE→SCHEMA role split as listTables: `database` names the
  // schema; a connection-bound database name (or empty) resolves to `public`.
  const schema = await resolvePgSchema(driver, database)
  const columnRows = await driver.query(
    `SELECT a.attname AS name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS columnType,
            NOT a.attnotnull AS nullable,
            pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS defaultValue,
            col_description(c.oid, a.attnum) AS comment
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
    [schema, table],
  )
  if (columnRows.length === 0) return null
  const columns: ColumnInfo[] = columnRows.map((row) => ({
    name: String(row['name'] ?? ''),
    columnType: String(row['columnType'] ?? ''),
    nullable: row['nullable'] === true ? 'YES' : 'NO',
    ...(row['defaultValue'] === null || row['defaultValue'] === undefined ? {} : { defaultValue: String(row['defaultValue']) }),
    ...(typeof row['comment'] === 'string' && row['comment'].length > 0 ? { comment: row['comment'] } : {}),
  }))
  const indexRows = await driver.query(
    `SELECT i.relname AS name, ix.indisunique AS isUnique, a.attname AS column_
       FROM pg_class t
       JOIN pg_index ix ON t.oid = ix.indrelid
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = $2
       ORDER BY i.relname, a.attnum`,
    [schema, table],
  )
  const grouped = new Map<string, IndexInfo>()
  for (const row of indexRows) {
    const name = String(row['name'] ?? '')
    const entry = grouped.get(name) ?? { name, unique: row['isUnique'] === true, columns: [] }
    entry.columns.push(String(row['column_'] ?? ''))
    grouped.set(name, entry)
  }
  let ddl: string | undefined
  try {
    // PG 12+ ships CREATE TABLE reconstruction via pg_get_partkeydef / array_agg of columns + constraints.
    // We keep DDL best-effort: only build a CREATE TABLE skeleton with columns when the system
    // catalogs are reachable; constraint text is omitted because assembling it faithfully is far
    // more code than the MySQL SHOW CREATE TABLE path and adds little for the AI workflow.
    const skeleton = `CREATE TABLE ${quoteIdentifier('postgresql', schema)}.${quoteIdentifier('postgresql', table)} (\n` +
      columns.map((c) => `  ${quoteIdentifier('postgresql', c.name)} ${c.columnType}${c.nullable === 'NO' ? ' NOT NULL' : ''}`).join(',\n') +
      `\n);`
    ddl = skeleton
  } catch {
    /* DDL is best-effort */
  }
  return { columns, indexes: [...grouped.values()], ...(ddl === undefined ? {} : { ddl }) }
}

async function describeSqlite(driver: QueryOnlyDriver, table: string): Promise<DescribeResult | null> {
  // PRAGMA table_info returns one row per column with name/type/notnull/dflt_value/pk.
  // It returns the table's own schema for plain names; we treat empty result as "no such table".
  const columnRows = await driver.query(`PRAGMA table_info(${quoteIdentifier('sqlite', table)})`, [])
  if (columnRows.length === 0) return null
  const columns: ColumnInfo[] = columnRows.map((row) => ({
    name: String(row['name'] ?? ''),
    columnType: String(row['type'] ?? ''),
    nullable: row['notnull'] === 0 || row['notnull'] === false ? 'YES' : 'NO',
    ...(row['dflt_value'] === null || row['dflt_value'] === undefined ? {} : { defaultValue: String(row['dflt_value']) }),
    ...(row['pk'] !== 0 && row['pk'] !== undefined ? { key: `PK#${row['pk']}` } : {}),
  }))
  const indexRows = await driver.query(`PRAGMA index_list(${quoteIdentifier('sqlite', table)})`, [])
  const grouped = new Map<string, IndexInfo>()
  for (const row of indexRows) {
    const name = String(row['name'] ?? '')
    const unique = Number(row['unique'] ?? 0) === 1
    const infoRows = await driver.query(`PRAGMA index_info(${quoteIdentifier('sqlite', name)})`, [])
    const cols: string[] = []
    for (const info of infoRows) cols.push(String(info['name'] ?? ''))
    if (cols.length > 0) grouped.set(name, { name, unique, columns: cols })
  }
  let ddl: string | undefined
  try {
    const ddlRows = await driver.query("SELECT sql FROM sqlite_master WHERE type IN ('table','view') AND name = ?", [table])
    const text = ddlRows[0]?.['sql']
    if (typeof text === 'string' && text.length > 0) ddl = text
  } catch {
    /* DDL is best-effort */
  }
  return { columns, indexes: [...grouped.values()], ...(ddl === undefined ? {} : { ddl }) }
}
