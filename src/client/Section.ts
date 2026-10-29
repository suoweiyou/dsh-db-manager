/**
 * db-manager settings section: connection management GUI (React, createElement
 * only — no JSX transform). Registered under the `settings.section` Slot as an
 * additive page; the component receives `{ close }` owner props from the shell.
 */
import { createElement as h, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { rpc, RpcError, type BuildStatusResponse, type ConnectionListItem, type ListResponse, type SshProfileView, type StatusResponse, type TableColumnView, type TableDescribeResponse, type TableIndexView, type TableListItem, type TablesListResponse, type TestResultView, type UsageResponse, type WorkspaceListItem, type WorkspacesListResponse } from './api.js'

const C = {
  text: 'var(--dsw-alias-label-primary, #e8e8e8)',
  textSecondary: 'var(--dsw-alias-label-secondary, #b8b8b8)',
  textTertiary: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
  border: 'var(--dsw-alias-border-l4, #3a3a3a)',
  card: 'var(--dsw-alias-bg-layer-1, #242424)',
  hover: 'var(--dsw-alias-interactive-bg-hover, #2e2e2e)',
  ok: 'var(--dsw-alias-status-positive, #4ade80)',
  bad: 'var(--dsw-alias-status-negative, #f87171)',
  idle: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
  warn: 'var(--dsw-alias-status-warning, #fbbf24)',
}

const inputStyle: Record<string, string | number> = {
  boxSizing: 'border-box',
  width: '100%',
  padding: '6px 8px',
  borderRadius: 8,
  border: `1px solid ${C.border}`,
  background: C.card,
  color: C.text,
  fontSize: 13,
}

const buttonStyle: Record<string, string | number> = {
  padding: '5px 12px',
  borderRadius: 8,
  border: `1px solid ${C.border}`,
  background: C.card,
  color: C.text,
  fontSize: 13,
  lineHeight: 1.5,
  cursor: 'pointer',
  // Buttons must never compress into two-line labels when the panel is narrow:
  // keep the label on one line and keep the button at its content width.
  whiteSpace: 'nowrap',
  flexShrink: 0,
  userSelect: 'none',
}

const primaryButtonStyle: Record<string, string | number> = { ...buttonStyle, background: C.hover }

type StatusMap = Record<string, TestResultView>
type EditorState =
  | { open: false }
  | {
      open: true
      /** Where the connection lives NOW (source for an update/move). */
      scope: 'global' | 'workspace'
      workspace?: string
      /** Where it should live AFTER saving (differing ⇒ a move between files). */
      destScope: 'global' | 'workspace'
      destWorkspace?: string
      originalName?: string
      name: string
      dialect: 'mysql' | 'postgresql' | 'sqlite'
      host: string
      port: string
      username: string
      defaultDatabase: string
      file: string
      mode: 'readonly' | 'readwrite'
      comment: string
      /** v0.21: display-only grouping label ('' ⇒ ungrouped). */
      group: string
      passwordMode: 'keep' | 'env' | 'plain' | 'enc' | 'none'
      passwordEnv: string
      passwordPlain: string
      passwordEnc: string
      sshProfile: string
    }

/**
 * How a secret field is supplied from the page (mirrors the connection password
 * modes). `none` is not a user-selectable mode: the page emits it when the
 * field was left empty, so the Host stores no secret at all (e.g. a private
 * key without a passphrase).
 */
type SecretMode = 'keep' | 'plain' | 'env' | 'enc' | 'none'

export type SshEditorState =
  | { open: false }
  | {
      open: true
      scope: 'global' | 'workspace'
      workspace?: string
      originalName?: string
      name: string
      host: string
      port: string
      username: string
      authMethod: 'agent' | 'keyfile' | 'key' | 'password'
      keyPath: string
      knownHostsPath: string
      passwordMode: SecretMode
      passwordEnv: string
      passwordPlain: string
      passwordEnc: string
      passphraseMode: SecretMode
      passphraseEnv: string
      passphrasePlain: string
      passphraseEnc: string
      privateKeyMode: SecretMode
      privateKeyEnv: string
      privateKeyPlain: string
      privateKeyEnc: string
    }

type BrowseState =
  | { phase: 'idle' }
  | { phase: 'list'; loading: boolean; database?: string; tables?: TableListItem[]; error?: string }
  | { phase: 'describe'; loading: boolean; database: string; table: string; tables?: TableListItem[]; describe?: TableDescribeResponse; error?: string }

function emptyEditor(scope: 'global' | 'workspace' = 'global', workspace?: string): EditorState {
  return {
    open: true,
    scope,
    ...(workspace === undefined ? {} : { workspace }),
    // A new connection is created exactly where the caller asked for it.
    destScope: scope,
    ...(workspace === undefined ? {} : { destWorkspace: workspace }),
    name: '',
    dialect: 'mysql',
    host: '',
    port: '3306',
    username: '',
    defaultDatabase: '',
    file: '',
    mode: 'readonly',
    comment: '',
    group: '',
    passwordMode: 'env',
    passwordEnv: '',
    passwordPlain: '',
    passwordEnc: '',
    sshProfile: '',
  }
}

/** A fresh SSH profile editor (FR-13). */
export function emptySshEditor(scope: 'global' | 'workspace' = 'global', workspace?: string): SshEditorState {
  return {
    open: true,
    scope,
    ...(workspace === undefined ? {} : { workspace }),
    name: '',
    host: '',
    port: '22',
    username: '',
    authMethod: 'keyfile',
    keyPath: '',
    knownHostsPath: '',
    passwordMode: 'env',
    passwordEnv: '',
    passwordPlain: '',
    passwordEnc: '',
    passphraseMode: 'env',
    passphraseEnv: '',
    passphrasePlain: '',
    passphraseEnc: '',
    privateKeyMode: 'env',
    privateKeyEnv: '',
    privateKeyPlain: '',
    privateKeyEnc: '',
  }
}

/** Pre-fill the SSH editor from an existing profile (secrets are never回显). */
export function sshEditorFrom(item: SshProfileView, workspace?: string): SshEditorState {
  return {
    ...(emptySshEditor(item.scope === 'workspace' ? 'workspace' : 'global', workspace) as Extract<SshEditorState, { open: true }>),
    originalName: item.name,
    name: item.name,
    host: item.host ?? '',
    port: item.port !== undefined ? String(item.port) : '22',
    username: item.username ?? '',
    authMethod: item.authMethod ?? 'keyfile',
    keyPath: item.keyPath ?? '',
    knownHostsPath: item.knownHostsPath ?? '',
    // Keep the stored secrets unless the user actively replaces them.
    passwordMode: 'keep',
    passphraseMode: 'keep',
    privateKeyMode: 'keep',
  }
}

function editorFromItem(item: ConnectionListItem, workspace?: string): EditorState {
  const scope = item.scope === 'workspace' ? 'workspace' as const : 'global' as const
  return {
    open: true,
    scope,
    ...(workspace === undefined ? {} : { workspace }),
    // Both start at the current location; the editor's「所属」select can change
    // the destination, which turns the save into a move between config files.
    destScope: scope,
    ...(workspace === undefined ? {} : { destWorkspace: workspace }),
    originalName: item.name,
    name: item.name,
    dialect: item.dialect,
    host: item.host ?? '',
    port: item.port !== undefined ? String(item.port) : '',
    username: item.username ?? '',
    defaultDatabase: item.defaultDatabase ?? '',
    file: item.file ?? '',
    mode: item.mode,
    comment: item.comment ?? '',
    group: item.group ?? '',
    passwordMode: item.dialect === 'sqlite' ? 'none' : 'keep',
    passwordEnv: '',
    passwordPlain: '',
    passwordEnc: '',
    sshProfile: item.sshProfile ?? '',
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function DbManagerSection(_props: { close: () => void }): ReactElement {
  const [list, setList] = useState<ConnectionListItem[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [statuses, setStatuses] = useState<StatusMap>({})
  const [usage, setUsage] = useState<UsageResponse>({})
  const [usageOpen, setUsageOpen] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState>({ open: false })
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [browse, setBrowse] = useState<Record<string, BrowseState>>({})
  const [tab, setTab] = useState<'global' | 'projects' | 'ssh'>('global')
  const [sshProfiles, setSshProfiles] = useState<SshProfileView[]>([])
  const [sshEditor, setSshEditor] = useState<SshEditorState>({ open: false })
  const [confirmDeleteSsh, setConfirmDeleteSsh] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[]>([])
  const [wsError, setWsError] = useState<string | null>(null)
  const [wsLoading, setWsLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({})
  /** v0.21: which grouping sections are collapsed, keyed per source (see groupStateKey). */
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [confirmDeleteWs, setConfirmDeleteWs] = useState<{ workspace: string; name: string } | null>(null)
  const [sshStatuses, setSshStatuses] = useState<StatusMap>({})
  const [sshBusy, setSshBusy] = useState<string | null>(null)
  /** Set when the running host is not the code on disk (restart required). */
  const [staleBuild, setStaleBuild] = useState<{ reason: string } | null>(null)

  /**
   * Ask the host which build it is actually running. Two failure modes both
   * mean "restart DSH": the host reports a hash mismatch, or the host is so old
   * that it does not even know `build.status` (404 未知 RPC 方法).
   */
  const checkBuildStatus = useCallback(async () => {
    try {
      const status = await rpc<BuildStatusResponse>('build.status')
      if (status.stale === true) {
        setStaleBuild({
          reason: `磁盘上的插件代码（${status.currentHash ?? '?'}，${status.files ?? 0} 个文件）与正在运行的代码（${status.loadedHash ?? '?'}）不一致。`,
        })
      } else if (status.available === false) {
        setStaleBuild({ reason: '当前 Host 未上报构建信息，可能是更早的版本。' })
      } else {
        setStaleBuild(null)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A missing method is the strongest possible staleness signal.
      if (/未知 RPC 方法|404/.test(message)) {
        setStaleBuild({ reason: `当前运行的 Host 是旧版本：它不认识 build.status 接口（${message}）。` })
      } else {
        setStaleBuild(null)
      }
    }
  }, [])

  const refresh = useCallback(async (): Promise<ListResponse | undefined> => {
    setLoadError(null)
    let result: ListResponse | undefined
    try {
      const data = await rpc<ListResponse>('connections.list')
      result = data
      setList(data.connections)
      setSshProfiles(data.sshProfiles ?? [])
      setWarnings(data.warnings)
      try {
        const status = await rpc<StatusResponse>('connections.status')
        const map: StatusMap = {}
        for (const result of status.results) map[result.name] = result
        setStatuses(map)
      } catch {
        /* status cache unavailable is non-fatal */
      }
      try {
        const usageData = await rpc<{ usage: UsageResponse }>('connections.usage')
        setUsage(usageData.usage ?? {})
      } catch {
        /* usage view unavailable is non-fatal */
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
    await checkBuildStatus()
    return result
  }, [checkBuildStatus])

  /** Project list for the「项目」tab (loaded lazily on first visit). */
  const loadWorkspaces = useCallback(async (): Promise<WorkspaceListItem[] | undefined> => {
    setWsLoading(true)
    setWsError(null)
    let result: WorkspaceListItem[] | undefined
    try {
      const data = await rpc<WorkspacesListResponse>('workspaces.list')
      result = data.workspaces
      setWorkspaces(data.workspaces)
    } catch (error) {
      setWsError(error instanceof Error ? error.message : String(error))
    } finally {
      setWsLoading(false)
    }
    return result
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (tab === 'projects') void loadWorkspaces()
  }, [tab, loadWorkspaces])

  /**
   * Open the connection editor. The「所属」select needs the project list, which
   * is otherwise loaded lazily for the「项目」tab — so fetch it on demand.
   */
  const openEditor = useCallback((next: EditorState): void => {
    setNotice(null)
    setEditor(next)
    if (workspaces.length === 0) void loadWorkspaces()
  }, [workspaces.length, loadWorkspaces])

  const testAll = useCallback(async () => {
    setBusy('(全部测试)')
    try {
      const data = await rpc<{ results: TestResultView[] }>('connections.testAll')
      const map: StatusMap = {}
      for (const result of data.results) map[result.name] = result
      setStatuses(map)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }, [])

  const remove = useCallback(async (name: string) => {
    try {
      await rpc('connections.delete', { name })
      setConfirmDelete(null)
      await refresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [refresh])

  /**
   * v0.21: copy a connection and open the copy in the editor.
   *
   * The host performs the copy from the **stored** entry, so the secret never
   * reaches the page and does not have to be retyped — the point of the feature
   * is "same server, another database". The editor then opens on the copy, so
   * the very next save renames it / points it at the sibling database.
   */
  const duplicate = useCallback(async (item: ConnectionListItem, workspace?: string) => {
    setNotice(null)
    setBusy(stateKey(item.scope, item.name, workspace))
    try {
      const created = await rpc<{ ok: boolean; name: string }>('connections.duplicate', {
        originalName: item.name,
        ...(workspace === undefined ? {} : { fromWorkspace: workspace }),
      })
      // Reload first, then hand the fresh row to the editor: the editor needs
      // the copy's real view (scope, group, defaultDatabase) and not a guess.
      if (workspace === undefined) {
        const data = await refresh()
        const copy = data?.connections.find((entry) => entry.name === created.name && entry.scope === 'global')
        if (copy !== undefined) openEditor(editorFromItem(copy))
      } else {
        const list = await loadWorkspaces()
        const copy = list?.find((ws) => ws.path === workspace)?.connections.find((entry) => entry.name === created.name)
        if (copy !== undefined) openEditor(editorFromItem(copy, workspace))
      }
      setNotice(`已复制为「${created.name}」（含密码与隧道配置）——改成目标库名后保存即可`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }, [refresh, loadWorkspaces, openEditor])

  /** v0.21: group sections collapse independently, keyed per source. */
  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: prev[key] !== true }))
  }, [])

  /** FR-13: persist one SSH profile (global, or a project's own when scoped). */
  const saveSshProfile = useCallback(async () => {
    if (!sshEditor.open) return
    setBusy('(保存 SSH)')
    try {
      const secret = (
        mode: SecretMode,
        env: string,
        plain: string,
        enc: string,
      ): { mode: SecretMode; env?: string; plain?: string; enc?: string } => {
        if (mode === 'keep') return { mode }
        // Empty input means "this profile has no such secret". Sending it as
        // `{ mode: 'env', env: '' }` made the Host reject the whole form with
        // "环境变量名不合法" — a passphrase-less key could not be saved at all.
        const value = mode === 'env' ? env.trim() : mode === 'enc' ? enc.trim() : plain
        if (value.length === 0) return { mode: 'none' }
        return {
          mode,
          ...(mode === 'env' ? { env: value } : {}),
          ...(mode === 'plain' ? { plain } : {}),
          ...(mode === 'enc' ? { enc: value } : {}),
        }
      }
      const profile: Record<string, unknown> = {
        name: sshEditor.name.trim(),
        host: sshEditor.host.trim(),
        ...(sshEditor.port.trim() === '' ? {} : { port: Number.parseInt(sshEditor.port, 10) || undefined }),
        username: sshEditor.username.trim(),
        auth: {
          method: sshEditor.authMethod,
          ...(sshEditor.authMethod === 'keyfile' && sshEditor.keyPath.trim().length > 0 ? { keyPath: sshEditor.keyPath.trim() } : {}),
          ...(sshEditor.authMethod === 'key' ? { privateKey: secret(sshEditor.privateKeyMode, sshEditor.privateKeyEnv, sshEditor.privateKeyPlain, sshEditor.privateKeyEnc) } : {}),
          ...(sshEditor.authMethod === 'password' ? { password: secret(sshEditor.passwordMode, sshEditor.passwordEnv, sshEditor.passwordPlain, sshEditor.passwordEnc) } : {}),
          ...(sshEditor.authMethod === 'keyfile' || sshEditor.authMethod === 'key'
            ? { passphrase: secret(sshEditor.passphraseMode, sshEditor.passphraseEnv, sshEditor.passphrasePlain, sshEditor.passphraseEnc) }
            : {}),
        },
      }
      if (sshEditor.knownHostsPath.trim().length > 0) profile.knownHostsPath = sshEditor.knownHostsPath.trim()
      await rpc('sshProfiles.save', {
        ...(sshEditor.originalName === undefined ? {} : { originalName: sshEditor.originalName }),
        ...(sshEditor.scope === 'workspace' && sshEditor.workspace !== undefined ? { workspace: sshEditor.workspace } : {}),
        profile,
      })
      setSshEditor({ open: false })
      await refresh()
      if (tab === 'projects') await loadWorkspaces()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }, [sshEditor, refresh, loadWorkspaces, tab])

  const removeSshProfile = useCallback(async (name: string) => {
    try {
      await rpc('sshProfiles.delete', { name })
      setConfirmDeleteSsh(null)
      await refresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [refresh])

  const removeWorkspaceConnection = useCallback(async (workspace: string, name: string) => {
    try {
      await rpc('workspaces.delete', { workspace, name })
      setConfirmDeleteWs(null)
      await loadWorkspaces()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }, [loadWorkspaces])

  /** Test one connection (optionally project-scoped) and fold the result into the status map. */
  const testSingle = useCallback(async (key: string, name: string, workspace?: string) => {
    setBusy(key)
    try {
      const data = await rpc<{ result: TestResultView }>('connections.test', { name, ...(workspace === undefined ? {} : { workspace }) })
      setStatuses((prev) => ({ ...prev, [key]: data.result }))
    } catch (error) {
      // Never swallow the verdict: a transport-level failure (or an old host
      // without the workspace parameter) must still show up on the card.
      setStatuses((prev) => ({
        ...prev,
        [key]: {
          name,
          ok: false,
          errorKind: 'unknown',
          message: error instanceof RpcError || error instanceof Error ? error.message : String(error),
          testedAt: Date.now(),
        },
      }))
    } finally {
      setBusy(null)
    }
  }, [])

  /** FR-13: validate one SSH configuration (reachability + host key + auth). */
  const testSshProfile = useCallback(async (name: string, workspace?: string) => {
    setSshBusy(name)
    try {
      const data = await rpc<{ result: TestResultView }>('sshProfiles.test', { name, ...(workspace === undefined ? {} : { workspace }) })
      setSshStatuses((prev) => ({ ...prev, [name]: data.result }))
    } catch (error) {
      setSshStatuses((prev) => ({
        ...prev,
        [name]: {
          name,
          ok: false,
          errorKind: 'unknown',
          message: error instanceof RpcError || error instanceof Error ? error.message : String(error),
          testedAt: Date.now(),
        },
      }))
    } finally {
      setSshBusy(null)
    }
  }, [])

  const save = useCallback(async () => {
    if (!editor.open) return
    setBusy('(保存)')
    // Source (where it lives now) vs destination (where it should live).
    const scope = editor.scope
    const workspace = editor.workspace
    const destScope = editor.destScope
    const destWorkspace = editor.destWorkspace
    const savedName = editor.name.trim()
    const moving = editor.originalName !== undefined && (destScope !== scope || destWorkspace !== workspace)
    const destLabel = destScope === 'workspace' ? (destWorkspace === undefined ? '项目' : basename(destWorkspace)) : '全局'
    try {
      const isSqlite = editor.dialect === 'sqlite'
      const connection = {
        name: savedName,
        dialect: editor.dialect,
        ...(isSqlite ? {} : { host: editor.host.trim() }),
        ...(isSqlite ? {} : { port: Number.parseInt(editor.port, 10) || undefined }),
        ...(isSqlite ? {} : { username: editor.username.trim() }),
        ...(isSqlite || editor.defaultDatabase.trim() === '' ? {} : { defaultDatabase: editor.defaultDatabase.trim() }),
        ...(isSqlite ? { file: editor.file.trim() } : {}),
        mode: editor.mode,
        ...(editor.comment.trim() === '' ? {} : { comment: editor.comment.trim() }),
        // v0.21: omitting the key clears the label (the host replaces the whole
        // entry, so "absent" really means "no group").
        ...(editor.group.trim() === '' ? {} : { group: editor.group.trim() }),
        passwordMode: isSqlite ? 'none' as const : editor.passwordMode,
        ...(editor.passwordMode === 'env' ? { passwordEnv: editor.passwordEnv.trim() } : {}),
        ...(editor.passwordMode === 'plain' ? { passwordPlain: editor.passwordPlain } : {}),
        ...(editor.passwordMode === 'enc' ? { passwordEnc: editor.passwordEnc.trim() } : {}),
        // FR-13: empty string clears the tunnel (explicit "不使用").
        ...(isSqlite || editor.sshProfile === '' ? {} : { sshProfile: editor.sshProfile }),
      }
      const originalName = editor.originalName === undefined ? {} : { originalName: editor.originalName }
      if (destScope === 'workspace' && destWorkspace === undefined) {
        setNotice('请选择要归属的项目（当前没有可用项目）')
        return
      }
      if (moving) {
        // Cross-file relocation: the host removes it from the source and writes
        // it into the destination, keeping the stored secret.
        const moved = await rpc<{ ok: boolean; warning?: string }>('connections.move', {
          ...originalName,
          ...(scope === 'workspace' && workspace !== undefined ? { fromWorkspace: workspace } : {}),
          ...(destScope === 'workspace' && destWorkspace !== undefined ? { toWorkspace: destWorkspace } : {}),
          connection,
        })
        setNotice(moved.warning === undefined
          ? `已把「${savedName}」移动到「${destLabel}」`
          : `已把「${savedName}」移动到「${destLabel}」，但需注意：${moved.warning}`)
      } else if (destScope === 'workspace') {
        await rpc('workspaces.save', { workspace: destWorkspace, ...originalName, connection })
      } else {
        await rpc('connections.save', { ...originalName, connection })
      }
      setEditor({ open: false })
      await refresh()
      // Both the source and the destination project may have changed.
      await loadWorkspaces()
      // Only probe the connection that was just written. A full testAll sweep
      // here made every save cost O(N) connection attempts (the more
      // connections you have, the slower adding one became).
      void testSingle(
        stateKey(destScope, savedName, destScope === 'workspace' ? destWorkspace : undefined),
        savedName,
        destScope === 'workspace' ? destWorkspace : undefined,
      )
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }, [editor, refresh, loadWorkspaces, testSingle])

  const browseOpen = useCallback(async (key: string, name: string, workspace?: string) => {
    setBrowse((prev) => ({ ...prev, [key]: { phase: 'list', loading: true } }))
    try {
      // `workspace` targets a project-private connection: without it the host
      // resolves the name in the GLOBAL file and would happily list a different
      // connection's tables.
      const data = await rpc<TablesListResponse>('tables.list', { name, ...(workspace === undefined ? {} : { workspace }) })
      // Stale-response guard (B2): if the panel was collapsed while the
      // request was in flight, browseClose already deleted the key — writing
      // via spread would resurrect it. Drop the response instead.
      setBrowse((prev) => (key in prev
        ? { ...prev, [key]: data.ok
            ? { phase: 'list', loading: false, database: data.database, tables: data.tables }
            : { phase: 'list', loading: false, error: data.error ?? '未知错误' } }
        : prev))
    } catch (error) {
      setBrowse((prev) => (key in prev
        ? { ...prev, [key]: { phase: 'list', loading: false, error: error instanceof Error ? error.message : String(error) } }
        : prev))
    }
  }, [])

  const browseSelectTable = useCallback(async (key: string, name: string, table: string, database: string, workspace?: string) => {
    // Carry the current table list into the describe phase so「← 返回表列表」
    // can restore it without a second RPC round-trip (L2 fix).
    setBrowse((prev) => ({ ...prev, [key]: { phase: 'describe', loading: true, database, table, tables: prev[key]?.phase === 'list' ? prev[key].tables : undefined } }))
    try {
      const data = await rpc<TableDescribeResponse>('tables.describe', { name, table, database, ...(workspace === undefined ? {} : { workspace }) })
      // Stale-response guard (B2): a slow describe for table A must never
      // overwrite a newer describe for table B (or a list/back state) — only
      // commit when the user is still looking at exactly this table.
      setBrowse((prev) => {
        const current = prev[key]
        const stillCurrent = current !== undefined && current.phase === 'describe' && current.table === table && current.database === database
        if (!stillCurrent) return prev
        const tables = current.tables
        return {
          ...prev,
          [key]: data.ok
            ? { phase: 'describe', loading: false, database, table, tables, describe: data }
            : { phase: 'describe', loading: false, database, table, tables, error: data.error ?? '未知错误' },
        }
      })
    } catch (error) {
      setBrowse((prev) => {
        const current = prev[key]
        const stillCurrent = current !== undefined && current.phase === 'describe' && current.table === table && current.database === database
        if (!stillCurrent) return prev
        const tables = current.tables
        return { ...prev, [key]: { phase: 'describe', loading: false, database, table, tables, error: error instanceof Error ? error.message : String(error) } }
      })
    }
  }, [])

  const browseBack = useCallback((key: string) => {
    setBrowse((prev) => {
      const current = prev[key]
      if (current === undefined || current.phase !== 'describe') return prev
      return {
        ...prev,
        [key]: {
          phase: 'list',
          loading: false,
          database: current.database,
          ...(current.tables === undefined ? {} : { tables: current.tables }),
        },
      }
    })
  }, [])

  const browseClose = useCallback((key: string) => {
    setBrowse((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  /**
   * Bind one connection (global or project-private) to the shared card. Both
   * tabs go through this, so every connection gets the same feature set:
   * test, table/DDL browser, usage details, edit, delete.
   */
  const bindCard = (item: ConnectionListItem, workspace?: string): CardBinding => {
    const key = stateKey(item.scope, item.name, workspace)
    const inProject = workspace !== undefined
    const browseState = browse[key]
    return {
      key,
      item,
      status: statuses[key],
      usage: usage[item.name],
      usageOpen: usageOpen === key,
      browse: browseState,
      busy: busy === key,
      confirming: inProject
        ? confirmDeleteWs !== null && confirmDeleteWs.workspace === workspace && confirmDeleteWs.name === item.name
        : confirmDelete === item.name,
      onTest: () => void testSingle(key, item.name, workspace),
      onEdit: () => openEditor(editorFromItem(item, workspace)),
      onDuplicate: () => void duplicate(item, workspace),
      onDeleteAsk: () => (inProject ? setConfirmDeleteWs({ workspace: workspace!, name: item.name }) : setConfirmDelete(item.name)),
      onDeleteConfirm: () => (inProject ? void removeWorkspaceConnection(workspace!, item.name) : void remove(item.name)),
      onDeleteCancel: () => (inProject ? setConfirmDeleteWs(null) : setConfirmDelete(null)),
      onToggleUsage: () => setUsageOpen((prev) => (prev === key ? null : key)),
      onBrowse: () => {
        // Toggle semantics: the label already reads「收起表」while the panel is
        // open (see renderCard) — the click must collapse it, not re-fetch (B1).
        if (browseState !== undefined && browseState.phase !== 'idle') browseClose(key)
        else void browseOpen(key, item.name, workspace)
      },
      onBrowseSelect: (table, database) => void browseSelectTable(key, item.name, table, database, workspace),
      onBrowseBack: () => browseBack(key),
      onBrowseClose: () => browseClose(key),
    }
  }

  const needle = filter.trim().toLowerCase()

  // D: filtering keeps the DOM small as the list grows (and doubles as search).
  const sorted = useMemo(() => {
    const matched = needle === ''
      ? list
      : list.filter((item) =>
          [item.name, item.host, item.defaultDatabase, item.comment, item.dialect, item.file]
            .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle)))
    return [...matched].sort((a, b) => a.name.localeCompare(b.name))
  }, [list, needle])

  const projectMatches = useMemo(() => {
    if (needle === '') return workspaces
    return workspaces.filter((ws) =>
      ws.path.toLowerCase().includes(needle) ||
      ws.connections.some((item) => item.name.toLowerCase().includes(needle)) ||
      (ws.globalUsage ?? []).some((entry) => entry.name.toLowerCase().includes(needle)))
  }, [workspaces, needle])

  const children: ReactElement[] = []

  const tabButton = (id: 'global' | 'projects' | 'ssh', label: string): ReactElement =>
    h('button', {
      key: id,
      style: {
        ...buttonStyle,
        ...(tab === id ? { background: C.hover, borderColor: C.textSecondary } : {}),
        fontSize: 12,
      },
      onClick: () => { setNotice(null); setFilter(''); setTab(id) },
    }, label)

  // Header
  children.push(
    h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 } },
      h('div', { style: { fontSize: 16, fontWeight: 600, color: C.text, whiteSpace: 'nowrap' } }, '数据库连接'),
      h('div', { style: { display: 'flex', gap: 8, flexShrink: 0 } },
        tab === 'global'
          ? h('button', { style: buttonStyle, disabled: busy !== null, onClick: () => void testAll() }, busy === '(全部测试)' ? '测试中…' : '全部测试')
          : tab === 'projects'
            ? h('button', { style: buttonStyle, disabled: wsLoading, onClick: () => void loadWorkspaces() }, wsLoading ? '加载中…' : '刷新项目')
            : h('button', { style: buttonStyle, onClick: () => void refresh() }, '刷新'),
        tab === 'global'
          ? h('button', { style: primaryButtonStyle, onClick: () => openEditor(emptyEditor('global')) }, '+ 添加连接')
          : tab === 'ssh'
            ? h('button', { style: primaryButtonStyle, onClick: () => { setNotice(null); setSshEditor(emptySshEditor('global')) } }, '+ 添加 SSH 配置')
            : null,
      ),
    ),
    h('div', { key: 'tabs', style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' } },
      tabButton('global', `全局连接（${list.length}）`),
      tabButton('projects', `项目（${workspaces.length}）`),
      tabButton('ssh', `SSH 配置（${sshProfiles.length}）`),
      h('input', {
        key: 'filter',
        style: { ...inputStyle, marginLeft: 'auto', flex: '1 1 200px', maxWidth: 260, fontSize: 12 },
        placeholder: tab === 'global' ? '搜索连接（名称/主机/库/备注）' : '搜索项目或连接',
        value: filter,
        onChange: (e: { target: { value: string } }) => setFilter(e.target.value),
      }),
    ),
  )

  if (loadError !== null) {
    children.push(
      h('div', { key: 'err', style: { marginBottom: 12, padding: '10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, color: C.bad, fontSize: 13, wordBreak: 'break-word' } },
        `加载失败：${loadError}`,
        h('button', { style: { ...buttonStyle, marginLeft: 12 }, onClick: () => void refresh() }, '重试'),
      ),
    )
  }
  if (warnings.length > 0) {
    children.push(
      h('div', { key: 'warn', style: { marginBottom: 12, padding: '10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, color: C.warn, fontSize: 12, whiteSpace: 'pre-wrap' } },
        warnings.map((w, i) => h('div', { key: i }, `⚠ ${w}`)),
      ),
    )
  }
  if (notice !== null) {
    children.push(
      h('div', { key: 'notice', style: { marginBottom: 12, padding: '10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, color: C.textSecondary, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('span', { style: { minWidth: 0, wordBreak: 'break-word', whiteSpace: 'pre-wrap' } }, notice),
        h('button', { style: { ...buttonStyle, fontSize: 12 }, onClick: () => setNotice(null) }, '知道了'),
      ),
    )
  }

  // Stale-build banner: Host-half changes only take effect after a DSH restart,
  // and this is the failure mode that otherwise shows up as a confusing 404.
  if (staleBuild !== null) {
    children.push(
      h('div', { key: 'stale', style: { marginBottom: 12, padding: '10px 12px', borderRadius: 10, border: `1px solid ${C.warn}`, color: C.warn, fontSize: 12, lineHeight: 1.7, wordBreak: 'break-word' } },
        h('div', { style: { fontWeight: 600 } }, '⚠ 插件代码已更新，但当前运行的是旧版本 —— 请重启 DSH'),
        h('div', { style: { marginTop: 2 } }, staleBuild.reason),
        h('div', { style: { marginTop: 2, color: C.textTertiary } },
          'Host 半区（工具、RPC、连接池）的改动只有重启 DSH 才会生效；刷新页面只更新界面，所以新界面调用新 RPC 时会出现「未知 RPC 方法」。',
        ),
      ),
    )
  }

  // FR-13: SSH profiles selectable for the connection being edited. They follow
  // the DESTINATION project (a profile declared by another project will not
  // resolve there), plus the global ones, which are visible everywhere.
  const sshOptionsFor = (destScope: 'global' | 'workspace', destWorkspace?: string): string[] => [
    ...sshProfiles.map((profile) => profile.name),
    ...(destScope === 'workspace' && destWorkspace !== undefined
      ? (workspaces.find((ws) => ws.path === destWorkspace)?.sshProfiles ?? []).map((profile) => profile.name)
      : []),
  ]
  const sshOptions = editor.open ? sshOptionsFor(editor.destScope, editor.destWorkspace) : []

  // Projects selectable as the destination (「所属」). Only projects the plugin
  // has observed can be written to (the host enforces the same whitelist).
  const projectOptions = workspaces.map((ws) => ({ path: ws.path, label: basename(ws.path) }))

  // v0.21: every group name already in use (global + all known projects), so the
  // editor can suggest them — a typo would otherwise split one group into two.
  const groupOptions = useMemo(() => {
    const names = new Set<string>()
    for (const item of list) if (typeof item.group === 'string' && item.group.trim() !== '') names.add(item.group.trim())
    for (const ws of workspaces) {
      for (const item of ws.connections) if (typeof item.group === 'string' && item.group.trim() !== '') names.add(item.group.trim())
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [list, workspaces])

  // Editors are rendered INLINE, right under the row they belong to, so editing
  // a connection at the bottom of a long list no longer requires scrolling back
  // to the top of the pane to see the form.
  const editorElement = editor.open
    ? renderEditor(editor, busy, {
        onSave: () => void save(),
        onCancel: () => setEditor({ open: false }),
        onField: (patch) => setEditor((prev) => (prev.open ? { ...prev, ...patch } : prev)),
      }, sshOptions, projectOptions, groupOptions)
    : null
  const sshEditorElement = sshEditor.open
    ? renderSshEditor(sshEditor, busy, {
        onSave: () => void saveSshProfile(),
        onCancel: () => setSshEditor({ open: false }),
        onField: (patch) => setSshEditor((prev) => (prev.open ? { ...prev, ...patch } : prev)),
      })
    : null
  const editorForGlobalRow = (item: ConnectionListItem): ReactElement | null =>
    editor.open && editor.scope === 'global' && editor.originalName === item.name ? editorElement : null
  const editorForSshRow = (profile: SshProfileView): ReactElement | null =>
    sshEditor.open && sshEditor.scope === 'global' && sshEditor.originalName === profile.name ? sshEditorElement : null
  // A brand-new global item has no row to attach to: show it at the top of its tab.
  const newGlobalEditor = editor.open && editor.scope === 'global' && editor.originalName === undefined ? editorElement : null
  const newSshEditor = sshEditor.open && sshEditor.originalName === undefined ? sshEditorElement : null

  if (tab === 'global') {
    // Global connection cards
    if (newGlobalEditor !== null) children.push(newGlobalEditor)
    if (sorted.length === 0 && loadError === null) {
      children.push(
        h('div', { key: 'empty', style: { padding: '20px 12px', textAlign: 'center', color: C.textTertiary, fontSize: 13, border: `1px dashed ${C.border}`, borderRadius: 10 } },
          list.length === 0
            ? '还没有任何连接。点击右上角「+ 添加连接」，或编辑 ~/.dsh/db-manager/connections.json。'
            : `没有匹配「${filter}」的连接。`,
        ),
      )
    } else {
      children.push(
        h('div', { key: 'cards', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          // v0.21: grouped cards collapse into sections; with no group in use the
          // list stays exactly as flat as before.
          ...renderGrouped(sorted, undefined, collapsedGroups, toggleGroup, (item) => {
            const binding = bindCard(item)
            return h('div', { key: binding.key, style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              renderBoundCard(binding),
              editorForGlobalRow(item),
            )
          }),
        ),
      )
    }
  } else if (tab === 'projects') {
    //「项目」tab: one card per known project, its private connections and the
    // global connections it has used.
    if (wsError !== null) {
      children.push(
        h('div', { key: 'wserr', style: { marginBottom: 12, padding: '10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, color: C.bad, fontSize: 13, wordBreak: 'break-word' } },
          `项目加载失败：${wsError}`,
          h('button', { style: { ...buttonStyle, marginLeft: 12 }, onClick: () => void loadWorkspaces() }, '重试'),
        ),
      )
    } else if (projectMatches.length === 0) {
      children.push(
        h('div', { key: 'wsempty', style: { padding: '20px 12px', textAlign: 'center', color: C.textTertiary, fontSize: 13, border: `1px dashed ${C.border}`, borderRadius: 10, lineHeight: 1.7 } },
          workspaces.length === 0
            ? '还没有观察到的项目。项目列表来自本插件服务过的会话工作区——在某个项目的会话里调用任一 db_* 工具（例如 db_list_connections）后，这里就会出现该项目。'
            : `没有匹配「${filter}」的项目或连接。`,
        ),
      )
    } else {
      children.push(
        h('div', { key: 'wscards', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          projectMatches.map((ws) => renderProjectCard(ws, {
            expanded: expandedProjects[ws.path] !== false,
            cardKeyFor: (item: ConnectionListItem) => stateKey(item.scope, item.name, ws.path),
            renderConnectionCard: (item: ConnectionListItem) => renderBoundCard(bindCard(item, ws.path)),
            editorFor: (item: ConnectionListItem) =>
              editor.open && editor.scope === 'workspace' && editor.workspace === ws.path && editor.originalName === item.name
                ? editorElement
                : null,
            newEditorSlot:
              editor.open && editor.scope === 'workspace' && editor.workspace === ws.path && editor.originalName === undefined
                ? editorElement
                : null,
            onToggle: () => setExpandedProjects((prev) => ({ ...prev, [ws.path]: prev[ws.path] === false })),
            onAdd: () => openEditor(emptyEditor('workspace', ws.path)),
            // v0.21: grouping inside the project card, keyed per project path.
            collapsedGroups,
            onToggleGroup: toggleGroup,
          })),
        ),
      )
    }
  } else if (tab === 'ssh') {
    //「SSH 配置」tab (FR-13): reusable jump-host profiles referenced by
    // connections via `sshProfile`. Secrets are write-only from here.
    children.push(
      h('div', { key: 'sshintro', style: { marginBottom: 10, padding: '8px 10px', borderRadius: 8, border: `1px solid ${C.border}`, color: C.textSecondary, fontSize: 12, lineHeight: 1.7 } },
        'SSH 配置用于「先连跳板机、再连数据库」的场景。在连接编辑里选择一条 SSH 配置即可让该连接走隧道。',
        h('br'),
        '主机密钥为**严格校验**：服务器公钥必须已存在于 known_hosts（默认 ~/.ssh/known_hosts），否则连接会被拒绝——请先用 ssh 手动登录一次以写入。',
      ),
    )
    if (newSshEditor !== null) children.push(newSshEditor)
    if (sshProfiles.length === 0) {
      children.push(
        h('div', { key: 'sshempty', style: { padding: '20px 12px', textAlign: 'center', color: C.textTertiary, fontSize: 13, border: `1px dashed ${C.border}`, borderRadius: 10 } },
          '还没有 SSH 配置。点击右上角「+ 添加 SSH 配置」创建一条，然后在连接编辑里选用。',
        ),
      )
    } else {
      children.push(
        h('div', { key: 'sshcards', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          sshProfiles.map((profile) => h('div', { key: profile.name, style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            renderSshCard(profile, sshStatuses[profile.name], sshBusy === profile.name, {
              confirming: confirmDeleteSsh === profile.name,
              onTest: () => void testSshProfile(profile.name),
              onEdit: () => { setNotice(null); setSshEditor(sshEditorFrom(profile)) },
              onDeleteAsk: () => setConfirmDeleteSsh(profile.name),
              onDeleteConfirm: () => void removeSshProfile(profile.name),
              onDeleteCancel: () => setConfirmDeleteSsh(null),
            }),
            editorForSshRow(profile),
          )),
        ),
      )
    }
  }

  children.push(
    h('div', { key: 'foot', style: { marginTop: 14, color: C.textTertiary, fontSize: 12, lineHeight: 1.6 } },
      tab === 'global'
        ? '这里维护的是全局连接（~/.dsh/db-manager/connections.json），所有工作区共享。「项目」标签页可查看各项目私有连接与项目使用过的全局连接。「SSH 配置」标签页维护可复用的跳板机配置。点击卡片上「查看表」可在浏览器中浏览某连接默认库的表清单与 DDL（只读，不会触碰数据行）。'
        : tab === 'projects'
          ? '项目列表来自本插件观察到的会话工作区（usage.json + 当前活跃会话），不会扫描磁盘上未使用过的项目。项目私有连接写入 <项目>/.dsh/db-manager.json，仅对该项目生效；「使用的全局连接」为该项目实际调用过的全局连接记录。'
          : 'SSH 配置可被多条连接复用（连接编辑里选择）。凭据仅以 $ENV:VAR 或 enc:v1 密文落盘，页面永远不回显。主机密钥严格校验：服务器公钥必须已在 known_hosts 中，否则拒连（先用 ssh 手动登录一次即可写入）。',
    ),
  )

  return h('div', { style: { maxWidth: 760, color: C.text, fontSize: 13 } }, children)
}

type SshCardHandlers = {
  confirming: boolean
  onTest: () => void
  onEdit: () => void
  onDeleteAsk: () => void
  onDeleteConfirm: () => void
  onDeleteCancel: () => void
}

/** One-line human summary of a test verdict (shared by connection + SSH cards). */
function testSummary(status: TestResultView | undefined): { dot: string; text: string } {
  if (status === undefined) return { dot: C.idle, text: '未测试' }
  if (status.ok) return { dot: C.ok, text: `可达（${status.latencyMs ?? '?'}ms，${formatTime(status.testedAt)} 检测）` }
  return { dot: C.bad, text: `不可达 — ${status.message ?? '未知原因'}` }
}

function sshAuthLabel(method: SshProfileView['authMethod']): string {
  if (method === 'agent') return 'ssh-agent'
  if (method === 'keyfile') return '私钥文件'
  if (method === 'key') return '私钥内容'
  if (method === 'password') return '密码'
  return '?'
}

/** One SSH profile card (FR-13). Secrets are shown only as presence markers. */
export function renderSshCard(profile: SshProfileView, status: TestResultView | undefined, busy: boolean, handlers: SshCardHandlers): ReactElement {
  const present: string[] = []
  if (profile.hasPrivateKey === true) present.push('私钥')
  if (profile.hasPassphrase === true) present.push('口令')
  if (profile.hasPassword === true) present.push('密码')
  const summary = testSummary(status)
  return h('div', { key: profile.name, style: { border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', background: C.card } },
    h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
      h('span', { style: { width: 10, height: 10, borderRadius: 10, background: summary.dot, flexShrink: 0 } }),
      h('span', { style: { fontWeight: 600, color: C.text, wordBreak: 'break-all' } }, profile.name),
      h('span', { style: { color: C.textSecondary, wordBreak: 'break-all' } }, `${profile.username ?? '?'}@${profile.host ?? '?'}:${profile.port ?? 22}`),
      h('span', { style: badgeStyle(profile.authMethod === 'agent' ? C.ok : C.textSecondary) }, sshAuthLabel(profile.authMethod)),
      profile.invalid === true ? h('span', { style: badgeStyle(C.bad) }, '字段不合法') : null,
      h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
        h('button', { style: buttonStyle, disabled: busy, onClick: handlers.onTest }, busy ? '测试中…' : '测试连接'),
        h('button', { style: buttonStyle, onClick: handlers.onEdit }, '编辑'),
        handlers.confirming
          ? h('span', { style: { display: 'flex', gap: 6 } },
              h('button', { style: { ...buttonStyle, color: C.bad }, onClick: handlers.onDeleteConfirm }, '确认删除'),
              h('button', { style: buttonStyle, onClick: handlers.onDeleteCancel }, '取消'),
            )
          : h('button', { style: buttonStyle, onClick: handlers.onDeleteAsk }, '删除'),
      ),
    ),
    h('div', { style: { marginTop: 4, color: status?.ok === false ? C.bad : C.textSecondary, fontSize: 12, wordBreak: 'break-word', whiteSpace: 'pre-wrap' } },
      busy ? '正在建立 SSH 连接（校验主机密钥与认证）…' : summary.text,
    ),
    status?.ok === false && status.hint !== undefined
      ? h('div', { style: { marginTop: 2, color: C.textTertiary, fontSize: 11, wordBreak: 'break-word', whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, `建议：${status.hint}`)
      : null,
    h('div', { style: { marginTop: 4, color: C.textTertiary, fontSize: 11, wordBreak: 'break-all' } },
      [
        profile.keyPath === undefined ? null : `私钥：${profile.keyPath}`,
        present.length === 0 ? null : `已配置机密：${present.join(' / ')}`,
        profile.knownHostsPath === undefined ? null : `known_hosts：${profile.knownHostsPath}`,
      ].filter((line): line is string => line !== null).join(' · ') || '（无附加信息）',
    ),
  )
}

type SshEditorHandlers = {
  onSave: () => void
  onCancel: () => void
  onField: (patch: Partial<Extract<SshEditorState, { open: true }>>) => void
}

/** SSH profile editor (FR-13). Secret fields are write-only. */
export function renderSshEditor(editor: Extract<SshEditorState, { open: true }>, busy: string | null, handlers: SshEditorHandlers): ReactElement {
  const isEdit = editor.originalName !== undefined
  const field = (label: string, key: 'name' | 'host' | 'port' | 'username' | 'keyPath' | 'knownHostsPath', extra?: Record<string, unknown>): ReactElement =>
    h('label', { key, style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px', fontSize: 12, color: C.textSecondary } },
      label,
      h('input', { style: inputStyle, value: editor[key], onChange: (e: { target: { value: string } }) => handlers.onField({ [key]: e.target.value }), ...(extra ?? {}) }),
    )

  const secretBlock = (
    label: string,
    prefix: 'password' | 'passphrase' | 'privateKey',
    enabled: boolean,
  ): ReactElement | null => {
    if (!enabled) return null
    const modeKey = `${prefix}Mode` as const
    const mode = editor[modeKey]
    const valueKey = `${prefix}${mode === 'env' ? 'Env' : mode === 'enc' ? 'Enc' : 'Plain'}` as 'passwordEnv' | 'passwordPlain' | 'passwordEnc' | 'passphraseEnv' | 'passphrasePlain' | 'passphraseEnc' | 'privateKeyEnv' | 'privateKeyPlain' | 'privateKeyEnc'
    return h('div', { key: prefix, style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' } },
      h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 160px', fontSize: 12, color: C.textSecondary } },
        `${label}方式`,
        h('select', {
          style: inputStyle,
          value: mode,
          onChange: (e: { target: { value: string } }) => handlers.onField({ [modeKey]: e.target.value as SecretMode } as Partial<Extract<SshEditorState, { open: true }>>),
        },
          ...(isEdit ? [h('option', { key: 'keep', value: 'keep' }, '保持不变')] : []),
          h('option', { key: 'env', value: 'env' }, '环境变量 $ENV:VAR'),
          h('option', { key: 'plain', value: 'plain' }, prefix === 'privateKey' ? '直接粘贴（Host 端加密）' : '直接输入（Host 端加密）'),
          h('option', { key: 'enc', value: 'enc' }, '粘贴 enc:v1 密文'),
        ),
      ),
      mode === 'keep'
        ? null
        : h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 240px', fontSize: 12, color: C.textSecondary } },
            mode === 'env' ? '环境变量名' : mode === 'enc' ? 'enc:v1 密文' : `${label}明文`,
            prefix === 'privateKey' && mode === 'plain'
              ? h('textarea', {
                  style: { ...inputStyle, minHeight: 90, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
                  value: editor[valueKey],
                  placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----',
                  onChange: (e: { target: { value: string } }) => handlers.onField({ [valueKey]: e.target.value } as Partial<Extract<SshEditorState, { open: true }>>),
                })
              : h('input', {
                  style: inputStyle,
                  type: mode === 'plain' ? 'password' : 'text',
                  value: editor[valueKey],
                  onChange: (e: { target: { value: string } }) => handlers.onField({ [valueKey]: e.target.value } as Partial<Extract<SshEditorState, { open: true }>>),
                }),
          ),
    )
  }

  return h('div', { key: 'ssheditor', style: { border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 10 } },
    h('div', { style: { fontSize: 14, fontWeight: 600 } }, isEdit ? `编辑 SSH 配置：${editor.originalName}` : '添加 SSH 配置'),
    h('div', { style: { fontSize: 12, color: C.textTertiary } },
      editor.scope === 'workspace'
        ? `写入目标：${editor.workspace ?? '?'}/.dsh/db-manager.json（仅该项目可见）`
        : '写入目标：~/.dsh/db-manager/connections.json（所有工作区共享）',
    ),
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      field('名称 *', 'name'),
      h('label', { key: 'authMethod', style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 190px', fontSize: 12, color: C.textSecondary } },
        '认证方式',
        h('select', {
          style: inputStyle,
          value: editor.authMethod,
          onChange: (e: { target: { value: string } }) => handlers.onField({ authMethod: e.target.value as 'agent' | 'keyfile' | 'key' | 'password' }),
        },
          h('option', { key: 'keyfile', value: 'keyfile' }, '私钥文件（推荐）'),
          h('option', { key: 'agent', value: 'agent' }, 'ssh-agent'),
          h('option', { key: 'key', value: 'key' }, '私钥内容（PEM）'),
          h('option', { key: 'password', value: 'password' }, '密码'),
        ),
      ),
    ),
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      field('跳板机 host *', 'host'),
      field('端口', 'port'),
      field('用户名 *', 'username'),
    ),
    editor.authMethod === 'keyfile' ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, field('私钥文件路径 *', 'keyPath', { placeholder: '~/.ssh/id_rsa' })) : null,
    secretBlock('私钥内容', 'privateKey', editor.authMethod === 'key'),
    secretBlock('密码', 'password', editor.authMethod === 'password'),
    secretBlock('私钥口令（留空表示私钥无口令）', 'passphrase', editor.authMethod === 'keyfile' || editor.authMethod === 'key'),
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      field('known_hosts 路径（留空用默认 ~/.ssh/known_hosts）', 'knownHostsPath'),
    ),
    h('div', { style: { fontSize: 12, color: C.textTertiary, lineHeight: 1.6 } },
      '主机密钥严格校验：请先用 ssh 手动登录一次该跳板机，使其公钥写入 known_hosts；非 22 端口需要 [host]:port 形式的条目。',
    ),
    h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      h('button', { style: buttonStyle, onClick: handlers.onCancel }, '取消'),
      h('button', { style: primaryButtonStyle, disabled: busy !== null, onClick: handlers.onSave }, busy === '(保存 SSH)' ? '保存中…' : '保存'),
    ),
  )
}

type ProjectHandlers = {
  expanded: boolean
  onToggle: () => void
  onAdd: () => void
  /** React key for one connection — must include the source (see stateKey). */
  cardKeyFor: (item: ConnectionListItem) => string
  /** The shared connection card bound to this project (same one as全局). */
  renderConnectionCard: (item: ConnectionListItem) => ReactElement
  /** Inline editor for one project connection (rendered under its card). */
  editorFor: (item: ConnectionListItem) => ReactElement | null
  /** Inline editor for a brand-new project connection. */
  newEditorSlot: ReactElement | null
  /** v0.21: collapse state of this project's grouping sections. */
  collapsedGroups: Record<string, boolean>
  onToggleGroup: (key: string) => void
}

/**
 * One project (workspace) card: where it lives, the connections it declares
 * privately, and the global connections it has actually used. Private
 * connections are editable here (they land in <project>/.dsh/db-manager.json);
 * the used-global list is read-only usage information.
 */
export function renderProjectCard(ws: WorkspaceListItem, handlers: ProjectHandlers): ReactElement {
  const name = basename(ws.path)
  const usedGlobal = ws.globalUsage ?? []
  const summary = `${ws.connections.length} 个项目私有连接${usedGlobal.length === 0 ? '' : ` · 使用过 ${usedGlobal.length} 个全局连接`}`
  return h('div', { key: ws.path, style: { border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', background: C.card } },
    h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
      h('span', { style: { fontWeight: 600, color: C.text, wordBreak: 'break-all' } }, name),
      h('span', { style: badgeStyle(ws.connections.length > 0 ? C.ok : C.idle) }, summary),
      ws.invalid === true ? h('span', { style: badgeStyle(C.bad) }, '配置无法解析') : null,
      !ws.exists && ws.connections.length === 0 ? h('span', { style: badgeStyle(C.idle) }, '无项目配置') : null,
      h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
        h('button', { style: buttonStyle, onClick: handlers.onAdd }, '+ 添加连接'),
        h('button', { style: buttonStyle, onClick: handlers.onToggle }, handlers.expanded ? '收起' : '展开'),
      ),
    ),
    h('div', { style: { marginTop: 4, color: C.textTertiary, fontSize: 11, wordBreak: 'break-all' }, title: ws.configPath }, ws.configPath),
    ws.warnings.length > 0
      ? h('div', { key: 'wswarn', style: { marginTop: 6, color: C.warn, fontSize: 12, whiteSpace: 'pre-wrap' } },
          ws.warnings.map((w, i) => h('div', { key: i }, `⚠ ${w}`)),
        )
      : null,
    handlers.expanded
      ? h('div', { key: 'wsbody', style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', null,
            h('div', { style: { fontSize: 12, color: C.textSecondary, marginBottom: 4 } }, `项目私有连接（仅本项目可见${ws.defaultConnection === undefined ? '' : ` · 默认 ${ws.defaultConnection}`}）`),
            ws.connections.length === 0
              ? h('div', { style: { color: C.textTertiary, fontSize: 12 } }, '暂无。点击「+ 添加连接」写入本项目的 .dsh/db-manager.json。')
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                  // v0.21: a project with several databases groups them the same
                  // way the global tab does (sections collapse independently).
                  ...renderGrouped(ws.connections, ws.path, handlers.collapsedGroups, handlers.onToggleGroup, (item) =>
                    // The very same card as the「全局连接」tab — table list,
                    // columns/indexes/DDL, usage details, test, edit, delete.
                    h('div', { key: handlers.cardKeyFor(item), style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                      handlers.renderConnectionCard(item),
                      handlers.editorFor(item),
                    ),
                  ),
                ),
          ),
          // A brand-new project connection's form lives inside this card, next
          // to the「+ 添加连接」button that opened it.
          handlers.newEditorSlot,
          usedGlobal.length > 0
            ? h('div', null,
                h('div', { style: { fontSize: 12, color: C.textSecondary, marginBottom: 4 } }, '该项目使用过的全局连接（只读）'),
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                  usedGlobal.map((entry) =>
                    h('div', { key: entry.name, style: { fontSize: 12, color: C.textSecondary } },
                      `· ${entry.name} —— ${entry.count} 次 · 最近 ${formatTime(entry.lastUsedAt)}`,
                    ),
                  ),
                ),
              )
            : null,
          ws.useGlobal !== undefined && ws.useGlobal.length > 0
            ? h('div', { style: { fontSize: 12, color: C.textTertiary } }, `useGlobal 白名单：${ws.useGlobal.join('、')}`)
            : null,
        )
      : null,
  )
}

type CardHandlers = {
  busy: boolean
  confirming: boolean
  onTest: () => void
  onEdit: () => void
  /** v0.21: copy this connection (host-side, secret included) and edit the copy. */
  onDuplicate: () => void
  onDeleteAsk: () => void
  onDeleteConfirm: () => void
  onDeleteCancel: () => void
  onToggleUsage: () => void
  onBrowse: () => void
  onBrowseSelect: (table: string, database: string) => void
  onBrowseBack: () => void
  onBrowseClose: () => void
}

function basename(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? normalized : normalized.slice(idx + 1)
}

function browseOpen(state: BrowseState | undefined): boolean {
  return state !== undefined && state.phase !== 'idle'
}

/**
 * Key for per-connection UI state (test verdict, browse panel, usage details).
 *
 * A project-private connection can share a name with a global one, and both are
 * rendered by the same card — so state must be keyed by *source + name*, not by
 * name alone, or clicking「查看表」on one would open the panel on the other.
 * `\u241f` (unit separator) cannot occur in a connection name or a path.
 */
export function stateKey(scope: string, name: string, workspace?: string): string {
  return scope === 'workspace' && workspace !== undefined
    ? `w\u241f${workspace}\u241f${name}`
    : `g\u241f${name}`
}

/** Everything the shared connection card needs, bound to one connection. */
export interface CardBinding {
  key: string
  item: ConnectionListItem
  status: TestResultView | undefined
  usage: { sessions: Array<{ sessionId: string; cwd?: string; lastUsedAt: number; count: number; lastAction?: string }>; workspaces: Array<{ path: string; lastUsedAt: number; count: number }> } | undefined
  usageOpen: boolean
  browse: BrowseState | undefined
  busy: boolean
  confirming: boolean
  onTest: () => void
  onEdit: () => void
  /** v0.21: copy this connection (host-side, secret included) and edit the copy. */
  onDuplicate: () => void
  onDeleteAsk: () => void
  onDeleteConfirm: () => void
  onDeleteCancel: () => void
  onToggleUsage: () => void
  onBrowse: () => void
  onBrowseSelect: (table: string, database: string) => void
  onBrowseBack: () => void
  onBrowseClose: () => void
}

/**
 * The single connection card used by BOTH tabs. The「项目」tab used to hand-roll
 * a reduced row, which is why project connections had no「查看表」(table list /
 * columns / indexes / DDL) and no usage details.
 */
export function renderBoundCard(binding: CardBinding): ReactElement {
  return renderCard(binding.item, binding.status, binding.usage, binding.usageOpen, binding.browse, {
    busy: binding.busy,
    confirming: binding.confirming,
    onTest: binding.onTest,
    onEdit: binding.onEdit,
    onDuplicate: binding.onDuplicate,
    onDeleteAsk: binding.onDeleteAsk,
    onDeleteConfirm: binding.onDeleteConfirm,
    onDeleteCancel: binding.onDeleteCancel,
    onToggleUsage: binding.onToggleUsage,
    onBrowse: binding.onBrowse,
    onBrowseSelect: binding.onBrowseSelect,
    onBrowseBack: binding.onBrowseBack,
    onBrowseClose: binding.onBrowseClose,
  })
}

/** v0.21: one display group of connections (`label: null` = the ungrouped bucket). */
export interface ConnectionGroup {
  label: string | null
  items: ConnectionListItem[]
}

const UNGROUPED_KEY = '__ungrouped__'
export const UNGROUPED_LABEL = '未分组'

/**
 * Bucket connections by their display-only `group` label (v0.21). Named groups
 * come first in locale order and the ungrouped bucket last; inside a bucket the
 * caller's order (already name-sorted) is preserved.
 */
export function groupConnections(items: ConnectionListItem[]): ConnectionGroup[] {
  const named = new Map<string, ConnectionListItem[]>()
  const ungrouped: ConnectionListItem[] = []
  for (const item of items) {
    const label = typeof item.group === 'string' ? item.group.trim() : ''
    if (label === '') {
      ungrouped.push(item)
      continue
    }
    const bucket = named.get(label)
    if (bucket === undefined) named.set(label, [item])
    else bucket.push(item)
  }
  const groups: ConnectionGroup[] = [...named.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, grouped]) => ({ label, items: grouped }))
  if (ungrouped.length > 0) groups.push({ label: null, items: ungrouped })
  return groups
}

/** Collapse-state key for one group (source-scoped, exactly like card keys). */
export function groupStateKey(label: string | null, workspace?: string): string {
  // stateKey branches on the scope ('workspace' is what carries the path), so the
  // source has to be passed through as the scope — otherwise every project's
  // groups of the same name would share one collapse flag.
  const name = `group:${label ?? UNGROUPED_KEY}`
  return workspace === undefined ? stateKey('global', name) : stateKey('workspace', name, workspace)
}

/**
 * One collapsible group section (v0.21). The header row is the toggle: it shows
 * a caret, the label, how many connections it holds and the current state, so a
 * collapsed group still says what it is hiding.
 */
export function renderGroupSection(
  key: string,
  label: string | null,
  count: number,
  collapsed: boolean,
  onToggle: () => void,
  body: ReactElement[],
): ReactElement {
  const title = label ?? UNGROUPED_LABEL
  return h('div', { key, style: { border: `1px solid ${C.border}`, borderRadius: 10, padding: '6px 8px' } },
    h('button', {
      key: 'head',
      'data-testid': 'group-header',
      style: { ...buttonStyle, width: '100%', display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-start', background: 'transparent', border: 'none', padding: '2px 4px' },
      onClick: onToggle,
    },
      h('span', { key: 'caret', style: { color: C.textSecondary, width: 12 } }, collapsed ? '▸' : '▾'),
      h('span', { key: 'label', style: { fontWeight: 600, color: C.text, wordBreak: 'break-all' } }, title),
      h('span', { key: 'count', style: badgeStyle(C.idle) }, String(count)),
      h('span', { key: 'hint', style: { marginLeft: 'auto', color: C.textTertiary, fontSize: 11 } }, collapsed ? '已收起' : '收起'),
    ),
    collapsed
      ? null
      : h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 } }, ...body),
  )
}

/**
 * Lay cards out as collapsible groups. With no named group at all the list stays
 * flat — headers only appear once grouping is actually in use, so an ungrouped
 * install looks exactly as before.
 */
function renderGrouped(
  items: ConnectionListItem[],
  workspace: string | undefined,
  collapsedGroups: Record<string, boolean>,
  onToggleGroup: (key: string) => void,
  renderOne: (item: ConnectionListItem) => ReactElement,
): ReactElement[] {
  const groups = groupConnections(items)
  if (!groups.some((group) => group.label !== null)) return items.map(renderOne)
  return groups.map((group) => {
    const key = groupStateKey(group.label, workspace)
    const collapsed = collapsedGroups[key] === true
    return renderGroupSection(key, group.label, group.items.length, collapsed, () => onToggleGroup(key), group.items.map(renderOne))
  })
}

export function renderCard(item: ConnectionListItem, status: TestResultView | undefined, usage: { sessions: Array<{ sessionId: string; cwd?: string; lastUsedAt: number; count: number; lastAction?: string }>; workspaces: Array<{ path: string; lastUsedAt: number; count: number }> } | undefined, usageOpen: boolean, browse: BrowseState | undefined, handlers: CardHandlers): ReactElement {
  const dot = status === undefined ? C.idle : status.ok ? C.ok : C.bad
  const statusText =
    status === undefined
      ? '未测试'
      : status.ok
        ? `可达（${status.latencyMs ?? '?'}ms，${formatTime(status.testedAt)} 检测）`
        : `不可达 — ${status.message ?? '未知原因'}${status.hint === undefined ? '' : `；建议：${status.hint}`}`
  const sessionCount = usage?.sessions.length ?? 0
  const workspaceCount = usage?.workspaces.length ?? 0
  const lastUsedAt = Math.max(0, ...(usage?.sessions.map((s) => s.lastUsedAt) ?? []), ...(usage?.workspaces.map((w) => w.lastUsedAt) ?? []))
  const usageSummary = sessionCount === 0 && workspaceCount === 0 ? null : `本进程 ${sessionCount} 个会话在用 · ${workspaceCount} 个工作区关联${lastUsedAt > 0 ? ` · 最近使用 ${formatTime(lastUsedAt)}` : ''}`
  return h('div', { key: item.name, style: { border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', background: C.card } },
    h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
      h('span', { 'data-testid': 'status-dot', style: { width: 10, height: 10, borderRadius: 10, background: dot, flexShrink: 0 } }),
      h('span', { style: { fontWeight: 600, color: C.text, wordBreak: 'break-all' } }, item.name),
      item.dialect === 'sqlite' ? null : h('span', { style: { color: C.textSecondary, wordBreak: 'break-all' } }, `${item.host ?? '?'}:${item.port ?? '?'}`),
      item.defaultDatabase === undefined ? null : h('span', { style: { color: C.textSecondary, wordBreak: 'break-all' } }, `/ ${item.defaultDatabase}`),
      h('span', { style: badgeStyle(item.mode === 'readonly' ? C.idle : C.warn) }, item.mode === 'readonly' ? '只读' : '读写'),
      h('span', { style: badgeStyle(item.dialect === 'mysql' ? C.textSecondary : item.dialect === 'postgresql' ? C.warn : C.ok) }, item.dialect === 'postgresql' ? 'PostgreSQL' : item.dialect === 'sqlite' ? 'SQLite' : 'MySQL'),
      // The same card serves both tabs, so the source is part of the card.
      h('span', { style: badgeStyle(item.scope === 'workspace' ? C.ok : C.idle) }, item.scope === 'workspace' ? '项目' : '全局'),
      item.sshProfile === undefined ? null : h('span', { style: badgeStyle(C.warn) }, `SSH ${item.sshProfile}`),
      item.invalid === true ? h('span', { style: badgeStyle(C.bad) }, '字段不合法') : null,
      item.file === undefined
        ? null
        : h('span', { style: { color: C.textTertiary, fontSize: 11, wordBreak: 'break-all', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.file }, `📁 ${item.file}`),
      h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
        h('button', { style: buttonStyle, disabled: handlers.busy, onClick: handlers.onTest }, handlers.busy ? '测试中…' : '测试'),
        h('button', { style: buttonStyle, onClick: handlers.onBrowse }, browseOpen(browse) ? '收起表' : '查看表'),
        h('button', { style: buttonStyle, onClick: handlers.onEdit }, '编辑'),
        // v0.21: sibling databases of one server — copy everything (secret
        // included, host-side) and edit just the database name.
        h('button', { style: buttonStyle, disabled: handlers.busy, onClick: handlers.onDuplicate }, handlers.busy ? '复制中…' : '复制'),
        handlers.confirming
          ? h('span', { style: { display: 'flex', gap: 6 } },
              h('button', { style: { ...buttonStyle, color: C.bad }, onClick: handlers.onDeleteConfirm }, '确认删除'),
              h('button', { style: buttonStyle, onClick: handlers.onDeleteCancel }, '取消'),
            )
          : h('button', { style: buttonStyle, onClick: handlers.onDeleteAsk }, '删除'),
      ),
    ),
    h('div', { style: { marginTop: 6, color: handlers.busy ? C.textTertiary : status === undefined || status.ok ? C.textTertiary : C.bad, fontSize: 12, wordBreak: 'break-word' } },
      handlers.busy ? '正在测试（建立连接/隧道）…' : statusText,
    ),
    usageSummary === null
      ? null
      : h('div', { style: { marginTop: 4, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 } },
          h('span', { style: { color: C.textTertiary, fontSize: 12, wordBreak: 'break-word' } }, `使用：${usageSummary}`),
          h('button', { style: { ...buttonStyle, fontSize: 11, padding: '2px 8px' }, onClick: handlers.onToggleUsage }, usageOpen ? '收起' : '明细'),
        ),
    usageSummary !== null && usageOpen && usage !== undefined
      ? h('div', { style: { marginTop: 8, padding: '8px 10px', borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 12, color: C.textSecondary, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', null, '当前进程会话（重启后清空）：'),
          usage.sessions.length === 0
            ? h('div', { style: { color: C.textTertiary } }, '（本进程内暂无会话使用）')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                usage.sessions.map((s, i) =>
                  h('div', { key: `${s.sessionId}-${i}` },
                    `· 会话 ${s.sessionId.slice(0, 8)}…${s.cwd === undefined ? '' : `（${basename(s.cwd)}）`} · ${s.count} 次 · 最近 ${formatTime(s.lastUsedAt)}${s.lastAction === undefined ? '' : ` · ${s.lastAction}`}`,
                  ),
                ),
              ),
          usage.workspaces.length > 0
            ? h('div', null,
                '工作区关联（跨重启持久）：',
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 } },
                  usage.workspaces.map((w, i) =>
                    h('div', { key: `${w.path}-${i}`, title: w.path },
                      `· ${basename(w.path)} · ${w.count} 次 · 最近 ${formatTime(w.lastUsedAt)}`,
                    ),
                  ),
                ),
              )
            : null,
        )
      : null,
    browsePanel(item, browse, {
      onSelect: handlers.onBrowseSelect,
      onBack: handlers.onBrowseBack,
      onClose: handlers.onBrowseClose,
    }),
  )
}

function browsePanel(item: ConnectionListItem, state: BrowseState | undefined, handlers: { onSelect: (table: string, database: string) => void; onBack: () => void; onClose: () => void }): ReactElement | null {
  if (state === undefined || state.phase === 'idle') return null
  const headerStyle: Record<string, string | number> = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }
  if (state.phase === 'list') {
    const databaseLabel = state.database === undefined ? item.defaultDatabase ?? '?' : state.database
    return h('div', { key: 'browse', style: { marginTop: 8, padding: '8px 10px', borderRadius: 8, border: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 6 } },
      h('div', { style: headerStyle },
        h('div', { style: { fontSize: 12, color: C.textSecondary } },
          state.loading
            ? `正在列出 ${databaseLabel} 中的表…`
            : state.error !== undefined
              ? `列出失败：${state.error}`
              : `${databaseLabel} 中共 ${state.tables?.length ?? 0} 个表（只读，不会执行数据查询）`,
        ),
        h('div', { style: { display: 'flex', gap: 6 } },
          state.phase === 'list' && !state.loading
            ? h('button', { style: { ...buttonStyle, fontSize: 11, padding: '2px 8px' }, onClick: handlers.onClose }, '收起')
            : null,
        ),
      ),
      state.error !== undefined
        ? null
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 240, overflowY: 'auto' } },
            (state.tables ?? []).length === 0 && !state.loading
              ? h('div', { style: { color: C.textTertiary, fontSize: 12 } }, '（该库没有表或视图）')
              : (state.tables ?? []).map((t) =>
                  h('div', { key: t.name, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.text } },
                    h('button', {
                      style: { ...buttonStyle, fontSize: 12, padding: '2px 10px' },
                      disabled: state.database === undefined,
                      onClick: () => state.database !== undefined && handlers.onSelect(t.name, state.database),
                    }, '查看 DDL'),
                    h('span', { style: { wordBreak: 'break-all' } }, t.name),
                    h('span', { style: badgeStyle(t.type === 'VIEW' ? C.ok : C.textSecondary) }, t.type === 'VIEW' ? '视图' : '表'),
                    t.comment !== undefined && t.comment.length > 0
                      ? h('span', { style: { color: C.textTertiary, fontSize: 11, wordBreak: 'break-word' } }, `—— ${t.comment}`)
                      : null,
                  ),
                ),
          ),
    )
  }
  // describe phase
  return h('div', { key: 'browse', style: { marginTop: 8, padding: '8px 10px', borderRadius: 8, border: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 6 } },
    h('div', { style: headerStyle },
      h('div', { style: { fontSize: 12, color: C.textSecondary } },
        state.loading
          ? `正在获取 ${state.database}.${state.table} 的结构与 DDL…`
          : state.error !== undefined
            ? `获取失败：${state.error}`
            : `${state.database}.${state.table}：${state.describe?.columns.length ?? 0} 列 · ${state.describe?.indexes.length ?? 0} 索引`,
      ),
      h('div', { style: { display: 'flex', gap: 6 } },
        h('button', { style: { ...buttonStyle, fontSize: 11, padding: '2px 8px' }, onClick: handlers.onBack }, '← 返回表列表'),
        h('button', { style: { ...buttonStyle, fontSize: 11, padding: '2px 8px' }, onClick: handlers.onClose }, '收起'),
      ),
    ),
    state.error !== undefined
      ? null
      : h(DescribeView, { describe: state.describe, loading: state.loading }),
  )
}

function DescribeView(props: { describe: TableDescribeResponse | undefined; loading: boolean }): ReactElement {
  if (props.loading || props.describe === undefined) {
    return h('div', { style: { color: C.textTertiary, fontSize: 12 } }, '加载中…')
  }
  const d = props.describe
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    h('div', null,
      h('div', { style: { fontSize: 12, color: C.textSecondary, marginBottom: 4 } }, '列'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 180, overflowY: 'auto' } },
        d.columns.map((c) => renderColumnRow(c)),
      ),
    ),
    d.indexes.length > 0
      ? h('div', null,
          h('div', { style: { fontSize: 12, color: C.textSecondary, marginBottom: 4 } }, '索引'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            d.indexes.map((i) => renderIndexRow(i)),
          ),
        )
      : null,
    d.ddl !== undefined
      ? h('div', null,
          h('div', { style: { fontSize: 12, color: C.textSecondary, marginBottom: 4 } }, 'DDL'),
          h('pre', { style: { margin: 0, padding: '8px 10px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, color: C.text, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflowY: 'auto' } }, d.ddl),
        )
      : null,
  )
}

function renderColumnRow(c: TableColumnView): ReactElement {
  return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 12, color: C.text, alignItems: 'baseline' } },
    h('span', { style: { fontWeight: 600 } }, c.name),
    h('span', { style: { color: C.textSecondary } }, c.columnType),
    c.nullable === 'NO' ? h('span', { style: { color: C.textTertiary } }, 'NOT NULL') : null,
    c.key !== undefined && c.key.length > 0 ? h('span', { style: { color: C.textTertiary } }, `[${c.key}]`) : null,
    c.defaultValue !== undefined && c.defaultValue.length > 0 ? h('span', { style: { color: C.textTertiary } }, `默认 ${c.defaultValue}`) : null,
    c.comment !== undefined && c.comment.length > 0 ? h('span', { style: { color: C.textTertiary } }, `—— ${c.comment}`) : null,
  )
}

function renderIndexRow(i: TableIndexView): ReactElement {
  return h('div', { style: { fontSize: 12, color: C.textSecondary } },
    `${i.name}${i.unique ? '（唯一）' : ''}: ${i.columns.join(', ')}`,
  )
}

function badgeStyle(color: string): Record<string, string | number> {
  return { fontSize: 11, padding: '1px 8px', borderRadius: 10, border: `1px solid ${C.border}`, color }
}

type EditorHandlers = {
  onSave: () => void
  onCancel: () => void
  onField: (patch: Partial<Extract<EditorState, { open: true }>>) => void
}

export function renderEditor(editor: Extract<EditorState, { open: true }>, busy: string | null, handlers: EditorHandlers, sshProfiles: string[] = [], projects: Array<{ path: string; label: string }> = [], groups: string[] = []): ReactElement {
  const isEdit = editor.originalName !== undefined
  const field = (label: string, key: 'name' | 'host' | 'port' | 'username' | 'defaultDatabase' | 'comment' | 'group', extra?: Record<string, unknown>): ReactElement =>
    h('label', { key, style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px', fontSize: 12, color: C.textSecondary } },
      label,
      h('input', { style: inputStyle, value: editor[key], onChange: (e: { target: { value: string } }) => handlers.onField({ [key]: e.target.value }), ...(extra ?? {}) }),
    )

  const passwordBlock = h('div', { key: 'pw', style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' } },
    h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 160px', fontSize: 12, color: C.textSecondary } },
      '密码方式',
      h('select', { style: inputStyle, value: editor.passwordMode, onChange: (e: { target: { value: string } }) => handlers.onField({ passwordMode: e.target.value as 'keep' | 'env' | 'plain' | 'enc' }) },
        ...(isEdit ? [h('option', { key: 'keep', value: 'keep' }, '保持不变')] : []),
        h('option', { key: 'env', value: 'env' }, '环境变量 $ENV:VAR'),
        h('option', { key: 'plain', value: 'plain' }, '直接输入（Host 端加密）'),
        h('option', { key: 'enc', value: 'enc' }, '粘贴 enc:v1 密文'),
      ),
    ),
    editor.passwordMode === 'env'
      ? h('input', { key: 'pw-env', style: { ...inputStyle, flex: '1 1 220px' }, placeholder: 'VAR_NAME（如 MYSQL_DEV_PW）', value: editor.passwordEnv, onChange: (e: { target: { value: string } }) => handlers.onField({ passwordEnv: e.target.value }) })
      : null,
    editor.passwordMode === 'plain'
      ? h('input', { key: 'pw-plain', type: 'password', style: { ...inputStyle, flex: '1 1 220px' }, placeholder: '输入密码（保存后即加密落盘，不再回显）', value: editor.passwordPlain, onChange: (e: { target: { value: string } }) => handlers.onField({ passwordPlain: e.target.value }) })
      : null,
    editor.passwordMode === 'enc'
      ? h('input', { key: 'pw-enc', style: { ...inputStyle, flex: '1 1 220px' }, placeholder: 'enc:v1:…（node bin/encrypt.js 生成）', value: editor.passwordEnc, onChange: (e: { target: { value: string } }) => handlers.onField({ passwordEnc: e.target.value }) })
      : null,
  )

  const isSqlite = editor.dialect === 'sqlite'
  const endpointBlock = isSqlite
    ? h('div', { key: 'endpoints-sqlite', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h('label', { key: 'file', style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 360px', fontSize: 12, color: C.textSecondary } },
          '数据库文件路径 *（绝对路径或工作区相对路径）',
          h('input', { style: inputStyle, placeholder: 'C:/data/app.db 或 ./data/app.db', value: editor.file, onChange: (e: { target: { value: string } }) => handlers.onField({ file: e.target.value }) }),
        ),
      )
    : h('div', { key: 'endpoints-server', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        field('主机 *', 'host'),
        field('端口', 'port', { inputMode: 'numeric' }),
      )

  const credentialsBlock = isSqlite
    ? null
    : h('div', { key: 'creds', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        field('用户名 *', 'username'),
        field('默认库', 'defaultDatabase'),
      )

  // FR-13: pick a reusable SSH profile so this connection goes through the
  // jump host. Server dialects only — a SQLite file is local.
  const sshBlock = isSqlite
    ? null
    : h('div', { key: 'ssh', style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' } },
        h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 260px', fontSize: 12, color: C.textSecondary } },
          'SSH 跳板机（可选）',
          h('select', {
            style: inputStyle,
            value: editor.sshProfile,
            onChange: (e: { target: { value: string } }) => handlers.onField({ sshProfile: e.target.value }),
          },
            h('option', { key: '', value: '' }, '不使用（直连数据库）'),
            ...sshProfiles.map((name) => h('option', { key: name, value: name }, `通过 SSH：${name}`)),
          ),
        ),
        h('div', { style: { flex: '1 1 240px', fontSize: 11, color: C.textTertiary, lineHeight: 1.6 } },
          sshProfiles.length === 0
            ? '暂无 SSH 配置——先到「SSH 配置」标签页添加一条（需先用 ssh 手动登录跳板机以写入 known_hosts）。'
            : '选中后，连接会先经该跳板机建立隧道再连数据库；主机密钥严格校验。',
        ),
      )

  const destIsWorkspace = editor.destScope === 'workspace'
  const moving = isEdit && (editor.destScope !== editor.scope || editor.destWorkspace !== editor.workspace)

  return h('div', { key: 'editor', style: { border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 10 } },
    h('div', { style: { fontSize: 14, fontWeight: 600 } },
      isEdit
        ? `编辑连接：${editor.originalName}`
        : editor.destScope === 'workspace' ? '添加项目私有连接' : '添加全局连接',
      moving ? h('span', { style: { marginLeft: 8, fontSize: 12, fontWeight: 400, color: C.warn } }, '（将更改所属）') : null,
    ),
    // 「所属」: where this connection is stored. Changing it moves the entry
    // between the global file and a project file (or between two projects).
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' } },
      h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 280px', fontSize: 12, color: C.textSecondary } },
        '所属',
        h('select', {
          style: inputStyle,
          value: destIsWorkspace ? `w\u241f${editor.destWorkspace ?? ''}` : 'g',
          onChange: (e: { target: { value: string } }) => {
            const value = e.target.value
            if (value === 'g') handlers.onField({ destScope: 'global', destWorkspace: undefined })
            else handlers.onField({ destScope: 'workspace', destWorkspace: value.slice(2) })
          },
        },
          h('option', { key: 'g', value: 'g' }, '全局（所有项目共享）'),
          ...projects.map((project) => h('option', { key: project.path, value: `w\u241f${project.path}` }, `项目：${project.label}`)),
        ),
      ),
      h('div', { style: { flex: '0 1 260px', fontSize: 11, color: C.textTertiary, lineHeight: 1.6 } },
        projects.length === 0
          ? '当前没有可选的观测项目（在本插件的某个会话里调用过 db_* 工具的项目才会出现）。'
          : moving ? '保存后会把该连接从原位置移出并写入新位置（密码等机密原样保留）。' : '决定这条连接写进哪个配置文件。',
      ),
    ),
    h('div', { style: { fontSize: 12, color: moving ? C.warn : C.textTertiary, wordBreak: 'break-all' } },
      destIsWorkspace
        ? `写入目标：${editor.destWorkspace ?? '?'}/.dsh/db-manager.json（仅该项目可见）`
        : '写入目标：~/.dsh/db-manager/connections.json（所有工作区共享）',
      moving
        ? `；原位置：${editor.scope === 'workspace' ? `${editor.workspace ?? '?'}/.dsh/db-manager.json` : '~/.dsh/db-manager/connections.json'}`
        : '',
    ),
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      field('名称 *', 'name'),
      h('label', { key: 'dialect', style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 160px', fontSize: 12, color: C.textSecondary } },
        '数据库类型',
        h('select', { style: inputStyle, value: editor.dialect, onChange: (e: { target: { value: string } }) => handlers.onField({ dialect: e.target.value as 'mysql' | 'postgresql' | 'sqlite' }) },
          h('option', { key: 'mysql', value: 'mysql' }, 'MySQL'),
          h('option', { key: 'pg', value: 'postgresql' }, 'PostgreSQL'),
          h('option', { key: 'sqlite', value: 'sqlite' }, 'SQLite'),
        ),
      ),
    ),
    endpointBlock,
    credentialsBlock,
    sshBlock,
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      h('label', { key: 'mode', style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 140px', fontSize: 12, color: C.textSecondary } },
        '访问模式',
        h('select', { style: inputStyle, value: editor.mode, onChange: (e: { target: { value: string } }) => handlers.onField({ mode: e.target.value as 'readonly' | 'readwrite' }) },
          h('option', { key: 'ro', value: 'readonly' }, '只读（推荐）'),
          h('option', { key: 'rw', value: 'readwrite' }, '读写'),
        ),
      ),
    ),
    isSqlite ? null : passwordBlock,
    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      field('备注', 'comment'),
      field('分组', 'group', {
        list: 'dbm-group-options',
        placeholder: '留空 = 不分组（例：10.0.0.5 / 生产库）',
      }),
    ),
    // v0.21: existing group names as suggestions, so sibling databases land in
    // the same section without retyping (or a typo creating a second one).
    h('datalist', { id: 'dbm-group-options' }, ...groups.map((g) => h('option', { key: g, value: g }))),
    h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
      h('button', { style: buttonStyle, onClick: handlers.onCancel }, '取消'),
      h('button', { style: primaryButtonStyle, disabled: busy !== null, onClick: handlers.onSave }, busy === '(保存)' ? '保存中…' : '保存'),
    ),
  )
}
