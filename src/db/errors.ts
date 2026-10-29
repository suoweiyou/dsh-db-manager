/**
 * Dialect-aware database error classification into PRD error kinds with
 * readable hints. Each driver throws different error shapes:
 *   - mysql2 puts `code` (e.g. `ER_ACCESS_DENIED_ERROR`) on the error object
 *   - pg puts `code` as the SQLSTATE string (e.g. `28P01`)
 *   - sqlite3 puts `code` (string like 'SQLITE_BUSY') and `errno` (number)
 * All three surfaces are unified here so callers see a stable `DbErrorKind`.
 */
import type { DbErrorKind, DbFailure } from '../shared/types.js'

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'])

/** MySQL2 error codes (subset; see audit M-series and MySQL Reference Manual). */
const MYSQL_AUTH_CODES = new Set(['ER_ACCESS_DENIED_ERROR', 'ER_NOT_SUPPORTED_AUTH_MODE'])
const MYSQL_BAD_DB_CODES = new Set(['ER_BAD_DB_ERROR'])
const MYSQL_PERMISSION_CODES = new Set([
  'ER_DBACCESS_DENIED_ERROR',
  'ER_ACCESS_DENIED_NO_USER_ERROR',
  'ER_SPECIFIC_ACCESS_DENIED_ERROR',
  'ER_TABLEACCESS_DENIED_ERROR',
  'ER_PRIVILEGE_CHECKS_USER_CANNOT_GRANT',
])
const MYSQL_SYNTAX_CODES = new Set(['ER_PARSE_ERROR', 'ER_SYNTAX_ERROR'])

/**
 * PostgreSQL SQLSTATE classes. The 5-character string is more informative
 * than MySQL's numeric codes; the leading two characters encode the class
 * (28 = auth, 3D = undefined object, 42 = syntax / access rule violation).
 */
const PG_CLASS_AUTH = '28' // 28000 invalid_auth_specification, 28001 / 28P01 password failure
const PG_CLASS_INVALID_CATALOG = '3D' // 3D000 invalid_catalog_name (database does not exist)
const PG_CLASS_SYNTAX = '42' // 42601 syntax_error, 42P10.. 428xx etc.

/** SQLite result codes (subset of sqlite3.h). sqlite3 puts these as `code` strings. */
const SQLITE_CODE_TIMEOUT = new Set(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE'])
const SQLITE_CODE_CANTOPEN = new Set(['SQLITE_CANTOPEN', 'SQLITE_CANTOPEN_CONVPATH', 'SQLITE_CANTOPEN_FULLPATH', 'SQLITE_CANTOPEN_ISDIR', 'SQLITE_CANTOPEN_NOTEMPDIR'])
const SQLITE_CODE_NOTADB = new Set(['SQLITE_NOTADB'])
const SQLITE_CODE_READONLY = new Set(['SQLITE_READONLY', 'SQLITE_READONLY_DBMOVED', 'SQLITE_READONLY_DIRECTORY', 'SQLITE_READONLY_TRANSACTION'])
const SQLITE_CODE_PERMISSION = new Set(['SQLITE_AUTH', 'SQLITE_PERM'])
const SQLITE_CODE_SYNTAX = new Set(['SQLITE_ERROR', 'SQLITE_MISMATCH', 'SQLITE_CONSTRAINT', 'SQLITE_RANGE', 'SQLITE_MISUSE'])

const KIND_LABEL: Record<DbErrorKind, string> = {
  network: '网络不可达',
  auth: '认证失败',
  'unknown-database': '数据库不存在',
  permission: '权限不足',
  timeout: '连接超时',
  syntax: 'SQL 语法错误',
  config: '配置问题',
  unknown: '连接失败',
}

const KIND_HINT: Record<DbErrorKind, string> = {
  network: '检查 host/port 是否正确、数据库是否在运行、防火墙/VPN 是否放行',
  auth: '检查用户名与密码；密码修改后请更新连接配置',
  'unknown-database': '默认库不存在：检查 defaultDatabase，或留空后由 SQL 显式指定库',
  permission: '该账号缺少所需权限，建议使用具备只读/读写权限的业务账号',
  timeout: '连接超时：检查网络状况与数据库负载，或在配置中调大 connectTimeoutMs',
  syntax: '请检查 SQL 语句语法',
  config: '请修正连接配置后重试',
  unknown: '可查看 DSH 日志获取详情，或用连接测试复核',
}

export function kindLabel(kind: DbErrorKind): string {
  return KIND_LABEL[kind]
}

/** Map MySQL/mysql2 error shapes to a DbErrorKind. */
function classifyMysqlCode(code: string, message: string): DbErrorKind {
  if (NETWORK_CODES.has(code)) return 'network'
  if (code === 'ETIMEDOUT' || code === 'PROTOCOL_SEQUENCE_TIMEOUT' || /connect timeout|handshake timeout/i.test(message)) return 'timeout'
  if (MYSQL_AUTH_CODES.has(code)) return 'auth'
  if (MYSQL_BAD_DB_CODES.has(code)) return 'unknown-database'
  if (MYSQL_PERMISSION_CODES.has(code)) return 'permission'
  if (MYSQL_SYNTAX_CODES.has(code)) return 'syntax'
  return 'unknown'
}

/** Map PostgreSQL SQLSTATE to a DbErrorKind. */
function classifyPgCode(code: string): DbErrorKind {
  // Network/timeout errors carry no SQLSTATE — pg surfaces them as Node-level
  // ECONNRESET/ECONNREFUSED/ETIMEDOUT, so the network branch above handles
  // them before we ever reach this code path.
  if (code.startsWith(PG_CLASS_AUTH)) return 'auth'
  if (code === '3F000') return 'unknown-database' // invalid_schema_name
  if (code.startsWith(PG_CLASS_INVALID_CATALOG)) return 'unknown-database' // 3Dxxx invalid_catalog_name
  if (code.startsWith(PG_CLASS_SYNTAX)) {
    // 42xxx covers both syntax errors and access-rule violations (privileges);
    // distinguish by the specific code when we can.
    if (code === '42501') return 'permission' // insufficient_privilege
    return 'syntax'
  }
  // pg also raises a few permission-ish codes outside the 42 syntax class.
  if (code === '42501') return 'permission'
  return 'unknown'
}

/** Map sqlite3 result codes to DbErrorKind. */
function classifySqliteCode(code: string): DbErrorKind {
  if (SQLITE_CODE_TIMEOUT.has(code)) return 'timeout'
  if (SQLITE_CODE_CANTOPEN.has(code)) return 'config'
  if (SQLITE_CODE_NOTADB.has(code)) return 'config'
  if (SQLITE_CODE_READONLY.has(code)) return 'config'
  if (SQLITE_CODE_PERMISSION.has(code)) return 'permission'
  if (SQLITE_CODE_SYNTAX.has(code)) return 'syntax'
  return 'unknown'
}

export function classifyDbError(err: unknown): DbFailure {
  const candidate = err as { code?: unknown; message?: unknown; errno?: unknown } | null
  const code = typeof candidate?.code === 'string' ? candidate.code : ''
  const message = typeof candidate?.message === 'string' && candidate.message.length > 0 ? candidate.message : String(err)
  let kind: DbErrorKind
  if (code.startsWith('ER_') || NETWORK_CODES.has(code) || code === 'ETIMEDOUT' || code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
    kind = classifyMysqlCode(code, message)
  } else if (/^[0-9A-Z]{5}$/.test(code)) {
    kind = classifyPgCode(code)
  } else if (code.startsWith('SQLITE_')) {
    kind = classifySqliteCode(code)
  } else if (/connect timeout|handshake timeout/i.test(message)) {
    kind = 'timeout'
  } else {
    kind = 'unknown'
  }
  // mysql2's query timeout is a client-side inactivity error: it reports the
  // failure but does not stop the server-side statement (audit M7) — say so
  // instead of letting a "failed" write appear rolled back.
  if (kind === 'timeout' && /inactivity/i.test(message)) {
    return {
      kind,
      message: `${KIND_LABEL[kind]}：${message}（注意：该超时由客户端判定，服务器端语句可能仍在执行）`,
      hint: '检查语句执行计划与数据量；必要时在数据库端 KILL 对应会话，并核对实际执行结果',
    }
  }
  return { kind, message: `${KIND_LABEL[kind]}：${message}`, hint: KIND_HINT[kind] }
}

/** Convert any thrown value (incl. SecretError) into a DbFailure. */
export function toDbFailure(err: unknown): DbFailure {
  if (err !== null && typeof err === 'object' && 'kind' in err && 'message' in err) {
    const candidate = err as Partial<DbFailure>
    if (typeof candidate.kind === 'string' && typeof candidate.message === 'string') {
      return { kind: candidate.kind as DbErrorKind, message: candidate.message, hint: candidate.hint }
    }
  }
  return classifyDbError(err)
}
