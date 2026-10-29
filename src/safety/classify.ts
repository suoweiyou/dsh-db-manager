/**
 * SQL safety gateway: AST statement classification via node-sql-parser with a
 * conservative regex/rule fallback. Parse failure never bypasses safety — it
 * degrades to the rule layer or the highest risk. The dialect is passed in by
 * the caller so the same gateway serves MySQL and PostgreSQL connections.
 */
// node-sql-parser v5 ships CommonJS only: ESM named imports from it fail at
// runtime, so import the default export and destructure defensively.
import sqlParserModule from 'node-sql-parser'
import type { DialectId } from '../shared/types.js'

interface SqlParserInstance {
  astify(sql: string, options?: { type: string }): unknown
  sqlify(ast: unknown, options?: { type: string }): string
}
type SqlParserCtor = new () => SqlParserInstance

const Parser = ((sqlParserModule as unknown as { Parser?: SqlParserCtor }).Parser ??
  (sqlParserModule as unknown as { default?: { Parser?: SqlParserCtor } }).default?.Parser) as SqlParserCtor

const parser = new Parser()

/** node-sql-parser dialect names (lowercase, mirrors the `type` option). */
const SQL_PARSER_DIALECT: Record<DialectId, 'mysql' | 'postgresql' | 'sqlite'> = {
  mysql: 'mysql',
  postgresql: 'postgresql',
  sqlite: 'sqlite',
}

export type StatementKind = 'read' | 'write' | 'ddl' | 'unknown'

export interface StatementClass {
  kind: StatementKind
  /**
   * The text to EXECUTE — always the caller's own (trimmed) statement, never a
   * parser regeneration. See `normalized`.
   */
  statement: string
  /**
   * Parser-regenerated canonical text of this statement, kept ONLY for the
   * round-trip safety cross-check in the tools layer (开发规范 §4.2 / 审计 N10).
   * Never execute it: node-sql-parser's `sqlify` ignores the `type` option for
   * identifier quoting and emits MySQL backticks for every dialect, which
   * PostgreSQL rejects outright (`syntax error at or near "`"`). Absent when
   * the dialect cannot be regenerated.
   */
  normalized?: string
  /** Requires explicit confirmation before execution in readwrite mode. */
  dangerous: boolean
  reason?: string
  /**
   * True when the statement may never be executed through this plugin at all
   * (session-state statements like USE/SET pollute shared pool connections;
   * the confirmation loop does not apply to them).
   */
  blocked?: boolean
  /** SELECT row limit when determinable; null = no limit clause present. */
  limit?: number | null
  /** True when the classification came from a real AST parse. */
  reliable: boolean
  /** Raw AST node (only when reliable) — used for row-backup planning. */
  ast?: unknown
}

export interface SqlClassification {
  statements: StatementClass[]
  /** False when any statement fell back to the rule layer. */
  reliable: boolean
}

const READ_TYPES = new Set(['select', 'show', 'describe', 'desc', 'explain'])
const WRITE_TYPES = new Set(['insert', 'update', 'delete', 'replace'])
const DDL_TYPES = new Set(['create', 'alter', 'drop', 'truncate', 'rename'])
/** Session-state statements: refused outright (they pollute pooled connections). */
const BLOCKED_TYPES = new Set(['use', 'set'])

function kindOfNodeType(nodeType: string): StatementKind {
  const lower = nodeType.toLowerCase()
  if (READ_TYPES.has(lower)) return 'read'
  if (WRITE_TYPES.has(lower)) return 'write'
  if (DDL_TYPES.has(lower)) return 'ddl'
  return 'unknown'
}

/**
 * EXPLAIN guard: the wrapped statement (node-sql-parser keeps it under the
 * `expr` property of an `explain` node) must itself be a read, otherwise the
 * whole statement must not pass as a read. MariaDB's `EXPLAIN ANALYZE <write>`
 * actually executes the inner statement, so an EXPLAIN of a write must never
 * pass the read channel on parser trust alone.
 */
export function explainInnerIsRead(nodeType: unknown): boolean {
  if (typeof nodeType !== 'string') return false
  const lower = nodeType.toLowerCase()
  return lower !== '' && READ_TYPES.has(lower)
}

function extractLimit(node: { limit?: unknown }): number | null {
  if (node.limit === undefined || node.limit === null) return null
  try {
    const value = (node.limit as { value?: Array<{ value?: unknown }> }).value
    const first = value?.[0]?.value
    if (typeof first === 'number') return first
    if (typeof first === 'string' && /^\d+$/.test(first)) return Number.parseInt(first, 10)
  } catch {
    /* undeterminable limit */
  }
  return Number.NaN // limit clause exists but value unreadable — treat as present
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Character scanner: split on top-level `;` and produce a strings/comments-stripped view. */
function scanStatements(sql: string): Array<{ text: string; stripped: string }> {
  const parts: Array<{ text: string; stripped: string }> = []
  let text = ''
  let stripped = ''
  let index = 0
  let dirty = false
  const push = () => {
    if (text.trim().length > 0) parts.push({ text: text.trim(), stripped: stripped.trim() })
    text = ''
    stripped = ''
    dirty = false
  }
  while (index < sql.length) {
    const char = sql[index]!
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      text += char
      stripped += ' '
      index += 1
      while (index < sql.length) {
        const inner = sql[index]!
        text += inner
        stripped += quote === '`' ? ' ' : 'x'
        if (inner === '\\' && quote !== '`') {
          index += 1
          if (index < sql.length) {
            text += sql[index]
            stripped += 'x'
          }
          index += 1
          continue
        }
        if (inner === quote) {
          if (quote !== '`' && sql[index + 1] === quote) {
            text += quote
            stripped += 'x'
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
        text += sql[index]
        index += 1
      }
      continue
    }
    if (char === '#') {
      while (index < sql.length && sql[index] !== '\n') {
        text += sql[index]
        index += 1
      }
      continue
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      const stop = end === -1 ? sql.length : end + 2
      text += sql.slice(index, stop)
      stripped += ' '
      index = stop
      continue
    }
    if (char === ';') {
      text += char
      index += 1
      push()
      continue
    }
    text += char
    stripped += char
    index += 1
  }
  if (text.trim().endsWith(';')) dirty = false
  push()
  return parts
}

/** Modifier keywords allowed between EXPLAIN and the wrapped statement. */
const EXPLAIN_MODIFIER = /^(EXTENDED|PARTITIONS|FORMAT\s*=\s*['"]?[A-Za-z_]+['"]?)\b/i

/**
 * Peel `EXPLAIN` plus its modifier keywords (ANALYZE / FORMAT=x / EXTENDED /
 * PARTITIONS) off a strings-stripped statement; report whether ANALYZE was
 * present, because `EXPLAIN ANALYZE <write>` executes the inner statement.
 */
function splitExplain(stripped: string): { rest: string; analyze: boolean } {
  let rest = stripped.replace(/^[([/\s]*EXPLAIN\b/i, '')
  let analyze = false
  for (let i = 0; i < 6; i += 1) {
    const trimmed = rest.replace(/^\s+/, '')
    if (/^ANALYZE\b/i.test(trimmed)) {
      analyze = true
      rest = trimmed.replace(/^ANALYZE\b/i, '')
      continue
    }
    const modifier = trimmed.match(EXPLAIN_MODIFIER)
    if (modifier !== null) {
      rest = trimmed.slice(modifier[0]!.length)
      continue
    }
    rest = trimmed
    break
  }
  return { rest, analyze }
}

function regexClassify(text: string, stripped: string): StatementClass {
  const verbMatch = stripped.match(/^[([/\s]*([A-Za-z]+)/)
  const verb = (verbMatch?.[1] ?? '').toUpperCase()
  let kind: StatementKind = 'unknown'
  let explainExecutesWrite = false
  if (verb === 'EXPLAIN') {
    // Classify the inner statement: EXPLAIN only keeps the read verdict when
    // the wrapped statement is itself a read (or `FOR CONNECTION`, which
    // shows another connection's plan). EXPLAIN ANALYZE of a write/ddl
    // actually executes it — refused outright; EXPLAIN of a write/ddl or an
    // unreadable inner statement degrades to unknown (highest risk).
    const { rest, analyze } = splitExplain(stripped)
    const innerVerb = (rest.match(/^[([/\s]*([A-Za-z]+)/)?.[1] ?? '').toUpperCase()
    if (READ_VERBS.has(innerVerb) || /^FOR\s+CONNECTION\b/i.test(rest)) {
      kind = 'read'
    } else if (analyze && (WRITE_VERBS.has(innerVerb) || DDL_VERBS.has(innerVerb))) {
      explainExecutesWrite = true
    }
  } else if (READ_VERBS.has(verb)) kind = 'read'
  else if (WRITE_VERBS.has(verb)) kind = 'write'
  else if (DDL_VERBS.has(verb)) kind = 'ddl'
  const intoFile = /\bINTO\s+(OUTFILE|DUMPFILE|@)/i.test(stripped)
  const sessionVerb = verb === 'USE' || verb === 'SET'
  if (sessionVerb) kind = 'unknown'
  const blocked = sessionVerb || explainExecutesWrite || (kind === 'read' && intoFile)
  const hasWhere = /\bWHERE\b/i.test(stripped)
  // Same as the AST layer: only UPDATE/DELETE carry the WHERE-missing risk;
  // INSERT/REPLACE never take a WHERE (audit M1).
  const dangerous =
    blocked ||
    kind === 'ddl' ||
    kind === 'unknown' ||
    (kind === 'write' && (verb === 'UPDATE' || verb === 'DELETE') && !hasWhere)
  const reason = blocked
    ? explainExecutesWrite
      ? 'EXPLAIN ANALYZE 会实际执行内层的写/DDL 语句，禁止通过本插件执行'
      : intoFile
        ? 'SELECT … INTO 会在数据库服务器上写文件或修改会话变量，禁止通过本插件执行'
        : 'USE/SET 会改变共享连接池中连接的会话状态，禁止通过本插件执行（charset 请写入连接配置 extraParams）'
    : reasonFor(kind, hasWhere)
  return {
    kind,
    statement: text,
    dangerous,
    ...(dangerous ? { reason } : {}),
    ...(blocked ? { blocked: true } : {}),
    limit: verb === 'SELECT' && !intoFile && /\bLIMIT\s+\d+/i.test(stripped) ? Number.NaN : verb === 'SELECT' ? null : undefined,
    reliable: false,
  }
}

const READ_VERBS = new Set(['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN'])
const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE'])
const DDL_VERBS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'])

function reasonFor(kind: StatementKind, hasWhere: boolean): string {
  if (kind === 'ddl') return 'DDL 语句会修改表结构或数据字典，执行前需要确认'
  if (kind === 'write' && !hasWhere) return 'UPDATE/DELETE 缺少 WHERE 条件，将影响全表'
  if (kind === 'unknown') return '无法可靠识别该语句的作用，按最高风险处理'
  return '高危操作，执行前需要确认'
}

/** Classify one SQL batch (single or multi-statement). */
export function classifySql(sql: string, dialect: DialectId = 'mysql'): SqlClassification {
  const trimmed = sql.trim()
  const parserDialect = SQL_PARSER_DIALECT[dialect]
  try {
    const ast = parser.astify(trimmed, { type: parserDialect })
    const nodes = Array.isArray(ast) ? ast : [ast]
    // Original per-statement text for multi-statement batches (a single
    // statement keeps the whole trimmed input, matching the historical shape).
    const originalParts = nodes.length > 1 ? scanStatements(trimmed).map((part) => part.text) : [trimmed]
    const statements: StatementClass[] = nodes.map((node, index) => {
      const nodeTypeRaw = typeof (node as { type?: unknown }).type === 'string' ? (node as { type: string }).type : ''
      const nodeType = nodeTypeRaw.toLowerCase()
      let kind = kindOfNodeType(nodeType)
      // EXPLAIN wrapper: only a read inner statement keeps the read verdict;
      // an EXPLAIN of a write/DDL (or unreadable inner) is blocked outright.
      let explainOfNonRead = false
      if (nodeType === 'explain' && !explainInnerIsRead((node as { expr?: { type?: unknown } }).expr?.type)) {
        kind = 'unknown'
        explainOfNonRead = true
      }
      // Execute the caller's own text; regenerate only for the round-trip
      // cross-check (`normalized`). Using the regeneration as the execution
      // text broke every parseable PostgreSQL query (see `normalized` docs).
      const statement = originalParts[index] ?? trimmed
      let normalized: string | undefined
      try {
        normalized = parser.sqlify(node, { type: parserDialect })
      } catch {
        /* dialect-unsupported regeneration — cross-check unavailable */
      }
      const hasWhere = (node as { where?: unknown }).where !== undefined && (node as { where?: unknown }).where !== null
      // SELECT ... INTO OUTFILE/DUMPFILE/@var writes files or session state on
      // the DB server — never executable through this plugin. Note: plain
      // SELECTs still carry `into: { position: null }` in the AST, so treat an
      // into node as real only when it carries more than that inert marker.
      // For EXPLAIN nodes the wrapped SELECT's `into` lives under `expr`.
      const intoNode = nodeType === 'explain' ? (node as { expr?: { into?: unknown } }).expr?.into : (node as { into?: unknown }).into
      const hasInto =
        intoNode !== undefined &&
        intoNode !== null &&
        typeof intoNode === 'object' &&
        Object.keys(intoNode as Record<string, unknown>).some((key) => key !== 'position' || (intoNode as Record<string, unknown>)['position'] !== null)
      const blocked = hasInto || BLOCKED_TYPES.has(nodeType) || explainOfNonRead
      // WHERE-missing is a full-table risk only for UPDATE/DELETE; INSERT and
      // REPLACE have no WHERE clause by grammar (audit M1 — they must not be
      // forced through the confirmation loop).
      const dangerousBase =
        blocked ||
        kind === 'ddl' ||
        kind === 'unknown' ||
        (kind === 'write' && (nodeType === 'update' || nodeType === 'delete') && !hasWhere)
      const reason = explainOfNonRead
        ? 'EXPLAIN 的内层语句不是只读查询，拒绝按只读处理（写操作请走 db_execute 确认闭环）'
        : blocked
          ? hasInto
            ? 'SELECT … INTO 会在数据库服务器上写文件或修改会话变量，禁止通过本插件执行'
            : 'USE/SET 会改变共享连接池中连接的会话状态，禁止通过本插件执行（charset 请写入连接配置 extraParams）'
          : reasonFor(kind, hasWhere)
      const limit = kind === 'read' && nodeType === 'select' && !hasInto ? extractLimit(node as { limit?: unknown }) : undefined
      return {
        kind,
        statement,
        ...(normalized === undefined ? {} : { normalized }),
        dangerous: dangerousBase,
        ...(dangerousBase ? { reason } : {}),
        ...(blocked ? { blocked: true } : {}),
        ...(limit === undefined ? {} : { limit }),
        reliable: true,
        ast: node,
      }
    })
    if (statements.length > 1) {
      const hasMutation = statements.some((s) => s.kind === 'write' || s.kind === 'ddl')
      if (hasMutation) {
        for (const s of statements) {
          if (s.kind === 'write' || s.kind === 'ddl') {
            s.dangerous = true
            s.reason = s.reason ?? '多语句批量操作中包含写/DDL 语句，整批需要确认'
          }
        }
      }
    }
    return { statements, reliable: true }
  } catch {
    const statements = scanStatements(trimmed).map((part) => regexClassify(part.text, part.stripped))
    if (statements.length === 0) {
      statements.push({ kind: 'unknown', statement: trimmed, dangerous: true, reason: reasonFor('unknown', false), reliable: false })
    }
    return { statements, reliable: false }
  }
}

/** True when the classification can be trusted as strictly read-only. */
export function isReadonlyBatch(classification: SqlClassification): boolean {
  return classification.statements.length > 0 && classification.statements.every((s) => s.kind === 'read' && !s.dangerous)
}

/**
 * Comment-safe LIMIT injection for fallback-classified SELECTs: appending
 * `LIMIT n` after a statement that ends with a line comment would be swallowed
 * by that comment, so wrap the statement in a derived table instead.
 */
export function injectReadLimit(statement: string, cap: number): string {
  const inner = statement.trim().replace(/;\s*$/, '')
  const safeCap = Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : 50
  return `SELECT * FROM (${inner}) AS __dbm_l LIMIT ${safeCap}`
}
