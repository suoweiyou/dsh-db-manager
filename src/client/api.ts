/** Typed fetch wrapper for the db-manager GUI RPC (token-gated same-origin POST). */
export class RpcError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'RpcError'
    this.status = status
  }
}

function readToken(): string | undefined {
  const value = (globalThis as Record<string, unknown>)['__DSH_DB_MANAGER_TOKEN__']
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export async function rpc<T>(method: string, args?: unknown): Promise<T> {
  const token = readToken()
  if (token === undefined) {
    throw new RpcError('缺少 RPC 令牌：请刷新 DSH 页面后重试（令牌随页面注入）', 0)
  }
  const response = await fetch(`/db-manager/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dbm-token': token },
    body: JSON.stringify(args ?? {}),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    let detail = ''
    try {
      const payload = (await response.json()) as { error?: unknown }
      if (typeof payload.error === 'string') detail = payload.error
    } catch {
      /* ignore body parse failures */
    }
    throw new RpcError(`RPC ${method} 失败（HTTP ${response.status}）${detail.length > 0 ? `：${detail}` : ''}`, response.status)
  }
  return (await response.json()) as T
}

export interface ConnectionListItem {
  name: string
  dialect: 'mysql' | 'postgresql' | 'sqlite'
  host?: string
  port?: number
  username?: string
  defaultDatabase?: string
  file?: string
  mode: 'readonly' | 'readwrite'
  comment?: string
  scope: string
  hasPassword: boolean
  invalid?: boolean
  /** FR-13: name of the SSH jump-host profile this connection uses, if any. */
  sshProfile?: string
  /** v0.21: display-only grouping label; cards sharing it collapse together. */
  group?: string
}

/** One whitelisted read-only log source (FR-22), as the settings page sees it. */
export interface SshLogSourceView {
  name: string
  kind: 'file' | 'journal'
  path?: string
  unit?: string
  label?: string
  via?: string
}

/** Credential-free SSH profile view (FR-13). */
export interface SshProfileView {
  name: string
  scope: string
  host?: string
  port?: number
  username?: string
  authMethod?: 'agent' | 'keyfile' | 'key' | 'password'
  keyPath?: string
  hasPrivateKey?: boolean
  hasPassphrase?: boolean
  hasPassword?: boolean
  knownHostsPath?: string
  /** FR-22: number of whitelisted log sources (badge on the card). */
  logSourceCount?: number
  /** FR-22: the whitelist itself, so the editor can round-trip it. */
  logSources?: SshLogSourceView[]
  invalid?: boolean
}

/** Stale-build report: is the code on disk newer than the running host? */
export interface BuildStatusResponse {
  available?: boolean
  libDir?: string
  loadedAt?: number
  loadedHash?: string | null
  currentHash?: string | null
  files?: number
  newestMtimeMs?: number
  stale?: boolean
}

export interface TestResultView {
  name: string
  ok: boolean
  latencyMs?: number
  errorKind?: string
  message?: string
  hint?: string
  testedAt: number
  /**
   * v0.22: which config file the probe targeted. The page keys verdicts by scope +
   * name (`stateKey`), so results coming from the host cache need these to find
   * their card. Absent on results produced by `connections.test` before v0.22 and
   * on `db_test_connection` output (which never reaches the page).
   */
  scope?: 'global' | 'workspace'
  workspace?: string
}

export interface ListResponse {
  connections: ConnectionListItem[]
  /** Global SSH profiles available to connections (FR-13). */
  sshProfiles?: SshProfileView[]
  warnings: string[]
}

export interface StatusResponse {
  results: TestResultView[]
}

export interface SessionUsageView {
  sessionId: string
  cwd?: string
  lastUsedAt: number
  count: number
  lastAction?: string
}

export interface WorkspaceUsageView {
  path: string
  lastUsedAt: number
  count: number
}

export type UsageResponse = Record<string, { sessions: SessionUsageView[]; workspaces: WorkspaceUsageView[] }>

export interface SaveArgs {
  originalName?: string
  connection: {
    name: string
    dialect?: 'mysql' | 'postgresql' | 'sqlite'
    host?: string
    port?: number
    username?: string
    defaultDatabase?: string
    file?: string
    mode?: 'readonly' | 'readwrite'
    comment?: string
    /** v0.21: grouping label; omit to keep the previous value on update. */
    group?: string
    passwordMode: 'keep' | 'env' | 'plain' | 'enc' | 'none'
    passwordEnv?: string
    passwordPlain?: string
    passwordEnc?: string
  }
}

export interface TableListItem {
  name: string
  type: string
  comment?: string
  rowsEstimate?: number
}

export interface TablesListResponse {
  ok: boolean
  connection: string
  dialect: 'mysql' | 'postgresql' | 'sqlite'
  database: string
  tables: TableListItem[]
  error?: string
  hint?: string
}

export interface TableColumnView {
  name: string
  columnType: string
  nullable: string
  defaultValue?: string
  key?: string
  extra?: string
  comment?: string
}

export interface TableIndexView {
  name: string
  unique: boolean
  columns: string[]
}

export interface TableDescribeResponse {
  ok: boolean
  connection: string
  dialect: 'mysql' | 'postgresql' | 'sqlite'
  database: string
  table: string
  columns: TableColumnView[]
  indexes: TableIndexView[]
  ddl?: string
  error?: string
  hint?: string
}

/** One global connection a project has actually used (usage tracking). */
export interface WorkspaceGlobalUsage {
  name: string
  count: number
  lastUsedAt: number
}

/** One project (workspace) row of the「项目」tab. */
export interface WorkspaceListItem {
  /** Absolute workspace directory. */
  path: string
  /** `<path>/.dsh/db-manager.json`. */
  configPath: string
  /** Whether that file exists on disk. */
  exists: boolean
  /** Private connections declared in the file (credentials never included). */
  connections: ConnectionListItem[]
  /** SSH profiles declared by this project (FR-13). */
  sshProfiles?: SshProfileView[]
  warnings: string[]
  /** Global-connection allowlist declared by the workspace file. */
  useGlobal?: string[]
  /** `default` from the workspace file. */
  defaultConnection?: string
  /** File exists but could not be parsed/validated. */
  invalid?: boolean
  /** Global connections this project used (read-only). */
  globalUsage?: WorkspaceGlobalUsage[]
}

export interface WorkspacesListResponse {
  workspaces: WorkspaceListItem[]
}

export interface WorkspaceSaveArgs {
  /** Absolute workspace path (must be a project the plugin has observed). */
  workspace: string
  originalName?: string
  connection: SaveArgs['connection']
}
