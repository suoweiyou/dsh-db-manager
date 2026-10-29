/** Shared connection resolution for db_* tools (sync; reads the config store). */
import type { ConfigStore, ResolvedSet } from '../config/store.js'
import type { ConnectionSpec, DialectId } from '../shared/types.js'

export interface ResolutionFailure {
  kind: 'config'
  message: string
  hint?: string
}

export interface ResolvedTarget {
  spec?: ConnectionSpec
  failure?: ResolutionFailure
  resolved: ResolvedSet
}

export function resolveTarget(store: ConfigStore, cwd: string | undefined, wanted: string | undefined): ResolvedTarget {
  const load = store.load(cwd)
  const resolved = store.resolveConnections(load)
  const names = resolved.connections.map((c) => c.name)
  const listHint = names.length > 0 ? `可用连接：${names.join('、')}` : '尚无可用连接：请编辑全局配置或调用 db_reload_config'
  const name = wanted !== undefined && wanted.length > 0 ? wanted : resolved.defaultName
  if (name === undefined) {
    return { failure: { kind: 'config', message: '未指定连接且无法确定默认连接', hint: listHint }, resolved }
  }
  const spec = resolved.connections.find((c) => c.name === name)
  if (spec === undefined) {
    return { failure: { kind: 'config', message: `连接 "${name}" 不存在或未通过配置校验`, hint: `${listHint}；若刚修改过配置文件可调用 db_reload_config` }, resolved }
  }
  return { spec, resolved }
}

/**
 * Identifier quoting for SQL composition. Each dialect uses its own native
 * quoting convention; the charset whitelist is the same so the validation
 * path is shared. MySQL & SQLite use backticks, PostgreSQL uses double
 * quotes (ANSI).
 */
const IDENTIFIER_RE = /^[\p{L}\p{N}_$]+$/u

export function quoteIdentifier(dialect: DialectId, identifier: string): string {
  if (!IDENTIFIER_RE.test(identifier)) {
    const label = dialect === 'mysql' ? 'MySQL' : dialect === 'postgresql' ? 'PostgreSQL' : 'SQLite'
    throw new Error(`非法的 ${label} 标识符 "${identifier.slice(0, 40)}"：仅允许字母、数字、下划线与 $`)
  }
  return dialect === 'postgresql' ? `"${identifier}"` : `\`${identifier}\``
}
