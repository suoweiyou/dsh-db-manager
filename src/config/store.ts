/**
 * Configuration store: loads the global connection file and the per-workspace
 * file, validates entries individually (one bad entry must not hide the rest),
 * caches by mtime for cheap hot-reload detection, and merges them with the
 * documented precedence (workspace same-name overrides global; default
 * resolution per PRD §6.3).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectionSchema, globalConfigSchema, workspaceConfigSchema, type GlobalConfig, type WorkspaceConfig } from './schema.js'
import type { ConnectionScope, ConnectionSpec, SshLogSourceSpec, SshProfileSpec } from '../shared/types.js'

export function defaultGlobalConfigPath(): string {
  const base = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(base, 'db-manager', 'connections.json')
}

export function workspaceConfigPath(cwd?: string): string | undefined {
  if (cwd === undefined || cwd.length === 0) return undefined
  return path.join(cwd, '.dsh', 'db-manager.json')
}

export interface FileLoad<T> {
  path: string
  exists: boolean
  data?: T
  /**
   * Parsed JSON before schema validation, kept so the GUI can still list the
   * entries that failed validation (shown as invalid cards) without re-reading
   * the file. Cached under the same mtime key as `data`.
   */
  raw?: unknown
  /** Per-entry or whole-file problems (readable, actionable). */
  warnings: string[]
  mtimeMs?: number
}

export interface ConfigLoad {
  global: FileLoad<GlobalConfig>
  workspace?: FileLoad<WorkspaceConfig>
}

export interface ResolvedConnection extends ConnectionSpec {
  scope: ConnectionScope
  isDefault: boolean
}

export interface ResolvedSet {
  connections: ResolvedConnection[]
  defaultName?: string
  warnings: string[]
}

/** FR-22: one whitelisted log source together with the profile that declares it. */
export interface ResolvedLogSource {
  profile: SshProfileSpec
  source: SshLogSourceSpec
  scope: ConnectionScope
}

const EMPTY_GLOBAL: FileLoad<GlobalConfig> = { path: '', exists: false, warnings: [] }

interface CacheEntry {
  mtimeMs: number
  load: FileLoad<unknown>
}

export class ConfigStore {
  readonly globalPath: string
  private readonly cache = new Map<string, CacheEntry>()

  constructor(options: { globalConfigPath?: string } = {}) {
    this.globalPath = options.globalConfigPath ?? defaultGlobalConfigPath()
  }

  /** Load global (+workspace when cwd known) config with mtime hot-reload. */
  load(cwd?: string, force = false): ConfigLoad {
    const global = this.loadFile(this.globalPath, () => globalConfigSchema, force)
    const wsPath = workspaceConfigPath(cwd)
    const workspace = wsPath === undefined ? undefined : this.loadFile(wsPath, () => workspaceConfigSchema, force)
    return { global, workspace }
  }

  invalidate(): void {
    this.cache.clear()
  }

  /**
   * Merge the loaded files. All global connections stay visible; workspace
   * private connections are added; a workspace connection with the same name
   * overrides the global one. Default: workspace `default` when present among
   * visible names, otherwise the single visible connection, otherwise none.
   */
  resolveConnections(load: ConfigLoad): ResolvedSet {
    const warnings: string[] = [...load.global.warnings]
    const byName = new Map<string, ResolvedConnection>()
    const push = (spec: ConnectionSpec, scope: ConnectionScope) => {
      const previous = byName.get(spec.name)
      if (previous !== undefined && previous.scope === 'workspace') return
      byName.set(spec.name, { ...spec, scope, isDefault: false })
    }
    // FR-2 / audit N9 (2nd round): `useGlobal` is a whitelist of global
    // connection names the workspace explicitly introduces. A non-empty list
    // restricts which global connections stay visible in this workspace; an
    // absent or empty list keeps the historical "all globals visible"
    // behavior for backward compatibility.
    const useGlobal = load.workspace?.data?.useGlobal
    const globalFilter = useGlobal !== undefined && useGlobal.length > 0 ? new Set(useGlobal) : undefined
    for (const spec of load.global.data?.connections ?? []) {
      if (globalFilter !== undefined && !globalFilter.has(spec.name)) continue
      push(spec, 'global')
    }
    const workspaceData = load.workspace?.data
    if (workspaceData !== undefined) {
      warnings.push(...(load.workspace?.warnings ?? []))
      for (const spec of workspaceData.connections) {
        // Shadowing is legitimate precedence but also the hijack vector for a
        // repo-supplied workspace file: make every override visible (audit M4).
        if (byName.get(spec.name)?.scope === 'global') {
          warnings.push(`工作区连接 "${spec.name}" 覆盖了同名全局连接（工作区文件：${load.workspace?.path ?? '?'}）；若非预期请检查该项目内的 .dsh/db-manager.json`)
        }
        push(spec, 'workspace')
      }
    }
    const connections = [...byName.values()]
    let defaultName: string | undefined
    const names = new Set(connections.map((c) => c.name))
    const wanted = workspaceData?.default
    if (wanted !== undefined && names.has(wanted)) defaultName = wanted
    else if (connections.length === 1) defaultName = connections[0]!.name
    for (const connection of connections) connection.isDefault = connection.name === defaultName
    return { connections, defaultName, warnings }
  }

  /**
   * Resolve the SSH (jump host) profile a connection references (FR-13).
   * Workspace profiles shadow global ones of the same name, mirroring the
   * connection precedence and warning the user about the override.
   */
  resolveSshProfile(
    load: ConfigLoad,
    spec: ConnectionSpec,
  ): { profile?: SshProfileSpec; error?: string } {
    const wanted = spec.sshProfile
    if (wanted === undefined || wanted.length === 0) return {}
    const globalProfiles = load.global.data?.sshProfiles ?? []
    const workspaceProfiles = load.workspace?.data?.sshProfiles ?? []
    const fromWorkspace = workspaceProfiles.find((profile) => profile.name === wanted)
    if (fromWorkspace !== undefined) return { profile: fromWorkspace }
    const fromGlobal = globalProfiles.find((profile) => profile.name === wanted)
    if (fromGlobal !== undefined) return { profile: fromGlobal }
    return {
      error: `连接 "${spec.name}" 引用的 SSH 配置 "${wanted}" 不存在（可用：${[...globalProfiles, ...workspaceProfiles].map((p) => p.name).join('、') || '无'}）`,
    }
  }

  /**
   * FR-22 — resolve one read-only log source by name. Precedence matches
   * `resolveSshProfile` (workspace profile shadows the global one), and the
   * source name is matched inside that profile's whitelist only — there is no
   * path/glob matching anywhere in this lookup.
   */
  resolveLogSource(
    load: ConfigLoad,
    profileName: string,
    sourceName: string,
  ): { resolved?: ResolvedLogSource; error?: string } {
    const visible = this.visibleSshProfiles(load)
    const profile = visible.find((entry) => entry.profile.name === profileName)
    if (profile === undefined) {
      const names = visible.map((entry) => entry.profile.name)
      return { error: `SSH 配置 "${profileName}" 不存在（可用：${names.join('、') || '无'}）` }
    }
    const sources = profile.profile.logSources ?? []
    if (sources.length === 0) {
      return {
        error: `SSH 配置 "${profileName}" 尚未登记任何日志源（可在设置页该 SSH 配置的「日志源白名单」里填写，或用 db_add_ssh_log_source 添加）`,
      }
    }
    const source = sources.find((entry) => entry.name === sourceName)
    if (source === undefined) {
      return { error: `SSH 配置 "${profileName}" 里没有名为 "${sourceName}" 的日志源（可用：${sources.map((entry) => entry.name).join('、')}）` }
    }
    return { resolved: { profile: profile.profile, source, scope: profile.scope } }
  }

  /**
   * Every SSH profile visible in this workspace (workspace first, then global
   * entries the workspace does not shadow). Used by `db_list_ssh_logs` so the
   * model can see which logs exist before asking for one.
   */
  visibleSshProfiles(load: ConfigLoad): Array<{ profile: SshProfileSpec; scope: ConnectionScope }> {
    const byName = new Map<string, { profile: SshProfileSpec; scope: ConnectionScope }>()
    for (const profile of load.global.data?.sshProfiles ?? []) {
      byName.set(profile.name, { profile, scope: 'global' })
    }
    for (const profile of load.workspace?.data?.sshProfiles ?? []) {
      byName.set(profile.name, { profile, scope: 'workspace' })
    }
    return [...byName.values()]
  }

  /** Read + validate one config file with per-entry granularity and mtime cache. */
  private loadFile<T>(filePath: string, makeSchema: () => FileSchema<T>, force = false): FileLoad<T> {
    let mtimeMs: number
    try {
      mtimeMs = fs.statSync(filePath).mtimeMs
    } catch {
      return { path: filePath, exists: false, warnings: [] }
    }
    const cached = this.cache.get(filePath)
    if (!force && cached !== undefined && cached.mtimeMs === mtimeMs) {
      return cached.load as FileLoad<T>
    }
    const load = readValidated<T>(filePath, makeSchema)
    this.cache.set(filePath, { mtimeMs, load: load as FileLoad<unknown> })
    return load
  }
}

interface FileSchema<T> {
  safeParse(value: unknown): { success: boolean; data?: T; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }
}

function readValidated<T>(filePath: string, makeSchema: () => FileSchema<T>): FileLoad<T> {
  const warnings: string[] = []
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    return { path: filePath, exists: false, warnings: [`读取配置失败：${error instanceof Error ? error.message : String(error)}`] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { path: filePath, exists: true, warnings: [`配置不是合法 JSON：${error instanceof Error ? error.message : String(error)}`] }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { path: filePath, exists: true, warnings: ['配置根必须是一个对象，如 { "connections": [ … ] }'] }
  }
  const record = parsed as Record<string, unknown>
  const rawConnections = record.connections
  if (rawConnections !== undefined && !Array.isArray(rawConnections)) {
    return { path: filePath, exists: true, warnings: ['"connections" 必须是数组'] }
  }
  // Fast path: the whole file validates as-is (preserves every top-level field).
  const fileSchema = makeSchema()
  const wholeCheck = fileSchema.safeParse(parsed)
  if (wholeCheck.success) {
    return { path: filePath, exists: true, data: wholeCheck.data, raw: parsed, warnings }
  }
  // Salvage path: keep valid connection entries, surface per-entry problems,
  // and preserve the remaining top-level fields (default, useGlobal, …).
  const valid: unknown[] = []
  if (Array.isArray(rawConnections)) {
    rawConnections.forEach((entry, index) => {
      const result = connectionSchema.safeParse(entry)
      if (result.success) {
        valid.push(result.data)
      } else {
        const label = (entry as { name?: unknown } | null)?.name
        const title = typeof label === 'string' && label.length > 0 ? `连接[${index}] "${label}"` : `连接[${index}]`
        warnings.push(`${title} 已跳过：${result.error.issues.map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`).join('；')}`)
      }
    })
  }
  const salvaged = fileSchema.safeParse({ ...(parsed as Record<string, unknown>), connections: valid })
  if (!salvaged.success) {
    for (const issue of salvaged.error?.issues ?? []) {
      warnings.push(`${issue.path.join('.') || '(根)'}: ${issue.message}`)
    }
  }
  return { path: filePath, exists: true, data: salvaged.success ? salvaged.data : ({ connections: valid } as T), raw: parsed, warnings }
}

export type { GlobalConfig, WorkspaceConfig }
