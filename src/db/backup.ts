/**
 * Row-level shadow backup for UPDATE/DELETE (用户需求：先备份、后变更).
 *
 * For a parsed single-table UPDATE/DELETE we can reconstruct the exact set of
 * affected rows: build a SELECT over the same table + WHERE via the SQL
 * parser's own renderer, then (server-side, no data crossing the wire):
 *   1. COUNT the matching rows,
 *   2. CREATE TABLE __dbm_backup_* (LIKE / LIKE INCLUDING ALL) <table>,
 *   3. INSERT INTO __dbm_backup_* SELECT * FROM (<select>) AS src.
 * Statements where the affected rows cannot be determined (multi-table JOIN,
 * REPLACE, unparsable SQL, unknown schema) are reported as "infeasible" so the
 * caller can refuse and let the user back up manually (backupAck to proceed).
 *
 * The shadow-table creation syntax is dialect-specific:
 *   - MySQL:        `CREATE TABLE x LIKE y`
 *   - PostgreSQL:   `CREATE TABLE x (LIKE y INCLUDING ALL)` (PG ≥ 10)
 */
import sqlParserModule from 'node-sql-parser'
import type { DialectId } from '../shared/types.js'
import { quoteIdentifier } from '../tools/resolve.js'

interface SqlParserInstance {
  astify(sql: string, options?: { type: string }): unknown
  sqlify(ast: unknown, options?: { type: string }): string
}

const Parser = ((sqlParserModule as unknown as { Parser?: new () => SqlParserInstance }).Parser ??
  (sqlParserModule as unknown as { default?: { Parser?: new () => SqlParserInstance } }).default?.Parser) as new () => SqlParserInstance

export interface RowBackupPlan {
  /** Shadow table name (validated charset, ≤ 64 chars). */
  backupName: string
  countSql: string
  createSql: string
  insertSql: string
  verifySql: string
  /** Ready-to-run manual backup statements for the oversize/infeasible prompt. */
  suggestSql: string
}

export type RowBackupDecision =
  | { kind: 'none'; reason: string }
  | { kind: 'infeasible'; reason: string; hint?: string; suggestSql?: string }
  | { kind: 'ready'; plan: RowBackupPlan }

interface TableRef {
  db?: string | null
  table?: string | null
  as?: string | null
  addition?: boolean | null
}

interface WriteAst {
  type?: string
  table?: unknown
  where?: unknown
}

const IDENTIFIER_RE = /^[\p{L}\p{N}_$]+$/u

function sanitizeBackupSegment(name: string): string {
  return name.replace(/[^\p{L}\p{N}_]+/gu, '_')
}

function renderSelectOf(node: WriteAst, dialect: DialectId): string {
  const parser = new Parser()
  const selectAst = { type: 'select', columns: '*', from: node.table, where: node.where ?? undefined }
  return parser.sqlify(selectAst, { type: dialect === 'postgresql' ? 'postgresql' : dialect === 'sqlite' ? 'sqlite' : 'mysql' })
}

function renderCreateLikeSql(dialect: DialectId, backupName: string, tableRef: string): string {
  if (dialect === 'postgresql') {
    // PG ≥ 10: (LIKE source INCLUDING ALL) copies columns, defaults, constraints, indexes.
    return `CREATE TABLE ${quoteIdentifier(dialect, backupName)} (LIKE ${tableRef} INCLUDING ALL)`
  }
  if (dialect === 'sqlite') {
    // SQLite has no `CREATE TABLE x LIKE y` syntax. We copy the structure with
    // `CREATE TABLE x AS SELECT * FROM y WHERE 0` (an empty result keeps the
    // column shape but drops PK / NOT NULL / DEFAULT — the trade-off is the
    // same as the PG best-effort skeleton: a faithful reconstruction of every
    // constraint would dwarf the actual backup work, and the user-facing goal
    // is "give me a quick way to revert the rows that just changed").
    return `CREATE TABLE ${quoteIdentifier(dialect, backupName)} AS SELECT * FROM ${tableRef} WHERE 0`
  }
  return `CREATE TABLE ${quoteIdentifier(dialect, backupName)} LIKE ${tableRef}`
}

/**
 * Plan a shadow backup for one write statement AST. The statement kind is
 * derived from the AST itself (insert → nothing to lose, replace → infeasible,
 * update/delete → plannable), so callers only pass the AST plus the fallback
 * schema and the target dialect. Returns 'infeasible' whenever the affected
 * rows cannot be reliably captured — the caller must then refuse, or proceed
 * on explicit user acknowledgement.
 */
export function planRowBackup(ast: unknown, fallbackDb: string | undefined, dialect: DialectId): RowBackupDecision {
  if (ast === undefined || ast === null) {
    return { kind: 'infeasible', reason: '语句未能通过解析器解析，无法确定将受影响的行', hint: '请自行备份后携带 backupAck: true 重试' }
  }
  const node = ast as WriteAst
  const nodeType = typeof node.type === 'string' ? node.type.toLowerCase() : ''
  // INSERT/REPLACE are not in the PG grammar (PG uses INSERT ... ON CONFLICT).
  // We only see those node types on MySQL connections.
  if (nodeType === 'insert') return { kind: 'none', reason: 'INSERT 新增行无需备份' }
  if (nodeType === 'replace') {
    return { kind: 'infeasible', reason: 'REPLACE 会删除冲突旧行且无法可靠定位受影响行，插件无法自动备份', hint: '请先自行备份目标表，或确认可接受数据丢失后携带 backupAck: true 重试' }
  }
  if (nodeType !== 'update' && nodeType !== 'delete') {
    return { kind: 'infeasible', reason: `无法识别的写语句类型 "${nodeType}"，不进行自动备份` }
  }
  const tableList = Array.isArray(node.table) ? (node.table as Array<Record<string, unknown>>) : []
  const target = tableList[0]
  // NOTE: node-sql-parser marks plain single-table DELETE targets with
  // `addition: true`, so the multi-table check must rely on the list length.
  if (target === undefined || tableList.length !== 1) {
    return { kind: 'infeasible', reason: '多表 / JOIN 更新或删除暂不支持自动备份', hint: '请自行备份相关表后携带 backupAck: true 重试' }
  }
  const rawTable = target['table']
  const tableName = typeof rawTable === 'string' ? rawTable : typeof (rawTable as { table?: unknown })?.table === 'string' ? String((rawTable as { table: unknown }).table) : ''
  const rawDb = typeof target['db'] === 'string' ? target['db'] : ''
  const alias = typeof target['as'] === 'string' && target['as'].length > 0 ? target['as'] : undefined
  const schema = rawDb !== '' && rawDb !== null ? rawDb : fallbackDb
  if (tableName.length === 0 || !IDENTIFIER_RE.test(tableName) || schema === undefined || !IDENTIFIER_RE.test(schema)) {
    return { kind: 'infeasible', reason: '无法确定目标表/库（语句未限定库且连接未配置默认库，或表名含不支持的字符）', hint: '请在语句中显式使用 `库`.`表` 限定，并确认连接配置了 defaultDatabase' }
  }
  let tableRef: string
  let selectOfRows: string
  try {
    const quotedTable = quoteIdentifier(dialect, tableName)
    const quotedDb = quoteIdentifier(dialect, schema)
    tableRef = `${quotedDb}.${quotedTable}`
    selectOfRows = renderSelectOf(node, dialect)
  } catch (error) {
    return { kind: 'infeasible', reason: error instanceof Error ? error.message : String(error) }
  }
  const stamp = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stampText = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`
  const base = `__dbm_backup_${sanitizeBackupSegment(tableName)}_${stampText}`.slice(0, 58)
  const backupName = `${base}_${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`
  if (!IDENTIFIER_RE.test(backupName) || backupName.length > 64) {
    return { kind: 'infeasible', reason: '无法生成合法的备份表名' }
  }
  const createSql = renderCreateLikeSql(dialect, backupName, tableRef)
  // PG LIMIT n for capping the INSERT source side is unnecessary — the SELECT
  // is filtered by WHERE the same way as the original UPDATE/DELETE.
  const insertSql = `INSERT INTO ${quoteIdentifier(dialect, backupName)} SELECT * FROM (${selectOfRows}) AS __dbm_src`
  const countSql = `SELECT COUNT(*) AS __dbm_c FROM (${selectOfRows}) AS __dbm_c_t`
  const verifySql = `SELECT COUNT(*) AS __dbm_c FROM ${quoteIdentifier(dialect, backupName)}`
  return {
    kind: 'ready',
    plan: {
      backupName,
      countSql,
      createSql,
      insertSql,
      verifySql,
      suggestSql: `${createSql};\n${insertSql};`,
    },
  }
}
