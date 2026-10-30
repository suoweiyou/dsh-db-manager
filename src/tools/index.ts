/** Model-facing db_* tools (M2): connection discovery, connectivity test, config reload. */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AuditLog } from '../audit/log.js'
import { saveConnectionInto } from '../config/mutate.js'
import type { ConfigStore } from '../config/store.js'
import type { PoolManager } from '../db/pool.js'
import type { UsageTracker } from '../usage.js'
import { probeConnection } from '../db/pool.js'
import { toDbFailure } from '../db/errors.js'
import { describePasswordIssue, resolvePassword } from '../secrets.js'
import { resolveSessionInfo, resolveWorkspaceCwd } from './workspace.js'
import { resolveTarget } from './resolve.js'
import { buildMetadataTools } from './metadata.js'
import { buildDataTools } from './data.js'
import { buildLogTools } from './logs.js'
import { DEFAULT_LOG_MAX_BYTES, DEFAULT_LOG_TIMEOUT_MS } from '../db/ssh-log.js'
import type { RequestHumanApproval } from '../safety/approval.js'
import type { ConnectionSpec, ConnectionTestResult, SshProfileSpec } from '../shared/types.js'

export interface ToolDeps {
  store: ConfigStore
  pools: PoolManager
  audit: AuditLog
  usage: UsageTracker
  connectTimeoutMs: number
  queryTimeoutMs: number
  maxRows: number
  backupEnabled: boolean
  backupMaxRows: number
  /** v0.10 — default backup policy. */
  backupDefault: 'always' | 'small-only' | 'opt-in'
  /** v0.10 — threshold for the 'small-only' policy (estimated rows). */
  backupSmallThreshold: number
  /** Optional host-side human approval channel gating dangerous statements. */
  requestApproval?: RequestHumanApproval
  /** FR-22 (v0.22): register the read-only SSH log tools (false = emergency stop). */
  logEnabled?: boolean
  /** FR-22: output quota per log read, in bytes (default 100000). */
  logMaxBytes?: number
  /** FR-22: per-read timeout in ms (default 10000). */
  logTimeoutMs?: number
}

const CONNECTION_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    dialect: { type: 'string', required: true, enum: ['mysql', 'postgresql', 'sqlite'] },
    host: { type: 'string' },
    port: { type: 'integer' },
    defaultDatabase: { type: 'string' },
    file: { type: 'string' },
    mode: { type: 'string', required: true, enum: ['readonly', 'readwrite'] },
    scope: { type: 'string', required: true, enum: ['workspace', 'global'] },
    isDefault: { type: 'boolean', required: true },
    available: { type: 'boolean', required: true },
    issue: { type: 'string' },
    /** FR-13: SSH jump-host profile this connection goes through, if any. */
    sshProfile: { type: 'string' },
    /** v0.21: display-only grouping label shared by sibling databases. */
    group: { type: 'string' },
  },
} as const

/** Run one standalone connectivity probe against a resolved connection. */
export async function testConnection(
  spec: ConnectionSpec,
  connectTimeoutMs: number,
  options?: { workspaceRoot?: string; sshProfile?: SshProfileSpec },
): Promise<ConnectionTestResult> {
  const testedAt = Date.now()
  try {
    // SQLite connections carry no password; everything else still needs the
    // stored secret resolved (env var or enc ciphertext) before connecting.
    const resolvedSpec = spec.dialect === 'sqlite'
      ? spec
      : { ...spec, password: resolvePassword(spec.password ?? '') }
    // The probe accepts an explicit workspace root for the SQLite sandbox so
    // the GUI test button can probe a path inside the current project.
    // Without an explicit root we fall back to process.cwd() (the directory
    // the DSH host was launched from) — a permissive default that still
    // refuses truly arbitrary paths (the file-open itself fails open).
    const root = options?.workspaceRoot !== undefined && options.workspaceRoot.length > 0
      ? options.workspaceRoot
      : process.cwd()
    const allowedRoots: ReadonlyArray<string> = [root]
    const probe = await probeConnection(resolvedSpec, {
      connectTimeoutMs,
      queryTimeoutMs: connectTimeoutMs,
      allowedRoots,
      // FR-13: test through the same SSH tunnel the pooled driver would use.
      ...(options?.sshProfile === undefined ? {} : { sshProfile: options.sshProfile }),
    })
    try {
      return { name: spec.name, ok: true, latencyMs: probe.latencyMs, testedAt }
    } finally {
      await probe.close()
    }
  } catch (error) {
    const failure = toDbFailure(error)
    return { name: spec.name, ok: false, errorKind: failure.kind, message: failure.message, hint: failure.hint, testedAt }
  }
}

export function buildTools(deps: ToolDeps): unknown[] {
  const listConnections = defineTool({
    name: 'db_list_connections',
    description:
      'List MySQL connections configured for dsh-db-manager: the global config plus the current session workspace file. ' +
      'Returns credential-free views (name/host/port/default database/mode/scope/default flag/availability). ' +
      'Use a returned connection name with the other db_* tools. Never returns passwords.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connections: { type: 'array', required: true, items: CONNECTION_VIEW_SCHEMA },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      } as const,
      render: (_args, value) => {
        const lines = value.connections.map((c: { isDefault: boolean; name: string; scope: string; dialect: string; host?: string; port?: number; defaultDatabase?: string; file?: string; mode: string; available: boolean; issue?: string }) => {
          const endpoint = c.dialect === 'sqlite'
            ? `${c.file ?? '?'}`
            : `${c.host ?? '?'}:${c.port ?? '?'}${c.defaultDatabase ? '/' + c.defaultDatabase : ''}`
          return `${c.isDefault ? '* ' : '- '}${c.name} [${c.scope}/${c.dialect}] ${endpoint} mode=${c.mode}${c.available ? '' : `（不可用：${c.issue}）`}`
        })
        if (lines.length === 0) lines.push('（尚未配置任何连接：编辑 ~/.dsh/db-manager/connections.json 或用设置页「数据库」分区添加）')
        for (const warning of value.warnings ?? []) lines.push(`警告：${warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      const cwd = resolveWorkspaceCwd(exec)
      const load = deps.store.load(cwd)
      const resolved = deps.store.resolveConnections(load)
      const connections = resolved.connections.map((c) => {
        const issue = c.password !== undefined ? describePasswordIssue(c.password) : undefined
        return {
          name: c.name,
          dialect: c.dialect,
          ...(c.host === undefined ? {} : { host: c.host }),
          ...(c.port === undefined ? {} : { port: c.port }),
          ...(c.defaultDatabase === undefined ? {} : { defaultDatabase: c.defaultDatabase }),
          ...(c.file === undefined ? {} : { file: c.file }),
          mode: c.mode,
          scope: c.scope,
          isDefault: c.isDefault,
          available: issue === undefined,
          ...(issue === undefined ? {} : { issue }),
          // FR-13: surface the tunnel target so the model knows the hop exists.
          ...(c.sshProfile === undefined ? {} : { sshProfile: c.sshProfile }),
          // v0.21: the grouping label the settings page renders as a section.
          ...(c.group === undefined ? {} : { group: c.group }),
        }
      })
      return { connections, warnings: resolved.warnings }
    },
    presentCall: () => ({ card: 'generic', title: '列出数据库连接', kind: 'read' }),
    isConcurrencySafe: () => true,
    timeoutMs: 5000,
  })

  const testConnectionTool = defineTool({
    name: 'db_test_connection',
    description:
      'Test one MySQL connection from dsh-db-manager: connects, runs SELECT 1, and reports latency on success or a classified ' +
      'failure (network/auth/unknown-database/permission/timeout/config) with an actionable hint. Omits the connection name to use the workspace default.',
    parameters: {
      connection: {
        type: 'string',
        description: 'Connection name from db_list_connections. Omit to use the workspace default connection.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          connection: { type: 'string', required: true },
          latencyMs: { type: 'integer' },
          errorKind: { type: 'string' },
          message: { type: 'string' },
          hint: { type: 'string' },
        },
      } as const,
      render: (_args, value) => {
        if (value.ok) return [{ type: 'text', text: `连接 ${value.connection} 正常（${value.latencyMs ?? '?'}ms）` }]
        const lines = [`连接 ${value.connection} 失败：${value.message ?? '未知原因'}`]
        if (value.hint !== undefined) lines.push(`建议：${value.hint}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const session = resolveSessionInfo(exec)
      const wanted = typeof (args as { connection?: unknown })?.connection === 'string' ? (args as { connection: string }).connection : undefined
      const target = resolveTarget(deps.store, session.cwd, wanted)
      const displayName = wanted ?? target.resolved.defaultName ?? '(default)'
      if (target.failure !== undefined || target.spec === undefined) {
        const failure = target.failure ?? { kind: 'config' as const, message: `连接 "${String(wanted)}" 不存在`, hint: '调用 db_list_connections 查看可用连接' }
        return { ok: false, connection: displayName, errorKind: failure.kind, message: failure.message, ...(failure.hint === undefined ? {} : { hint: failure.hint }) }
      }
      // FR-13: test through the connection's SSH tunnel when one is configured.
      const ssh = target.spec.sshProfile === undefined
        ? {}
        : deps.store.resolveSshProfile(deps.store.load(session.cwd), target.spec)
      if (ssh.error !== undefined) {
        return { ok: false, connection: target.spec.name, errorKind: 'config' as const, message: ssh.error, hint: '检查连接的 sshProfile 名称，或先定义对应的 SSH 配置' }
      }
      const result = await testConnection(target.spec, deps.connectTimeoutMs, ssh.profile === undefined ? undefined : { sshProfile: ssh.profile })
      deps.usage.record(target.spec.name, session.sessionId, session.cwd, 'db_test_connection')
      return {
        ok: result.ok,
        connection: result.name,
        ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
        ...(result.errorKind === undefined ? {} : { errorKind: result.errorKind }),
        ...(result.message === undefined ? {} : { message: result.message }),
        ...(result.hint === undefined ? {} : { hint: result.hint }),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `测试数据库连接${typeof args?.connection === 'string' ? `：${args.connection}` : ''}`, kind: 'read' }),
    isConcurrencySafe: () => true,
    timeoutMs: 10_000,
  })

  const reloadConfig = defineTool({
    name: 'db_reload_config',
    description: 'Reload dsh-db-manager connection configuration from disk (global file plus the current workspace file) and report what was loaded, including per-entry validation warnings.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          globalPath: { type: 'string', required: true },
          workspacePath: { type: 'string' },
          loadedConnections: { type: 'integer', required: true },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      } as const,
      render: (_args, value) => {
        const lines = [`已重载配置：${value.loadedConnections} 个连接（全局：${value.globalPath}${value.workspacePath === undefined ? '' : `；工作区：${value.workspacePath}`}）`]
        for (const warning of value.warnings ?? []) lines.push(`警告：${warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      const cwd = resolveWorkspaceCwd(exec)
      deps.store.invalidate()
      const load = deps.store.load(cwd, true)
      const resolved = deps.store.resolveConnections(load)
      // Drop pools whose connection vanished from the config.
      void deps.pools.retainOnly(new Set(resolved.connections.map((c) => c.name)))
      deps.audit.record({ ts: Date.now(), channel: 'tool', action: 'db_reload_config', status: 'ok', detail: `loaded ${resolved.connections.length} connection(s), ${resolved.warnings.length} warning(s)` })
      return {
        ok: true,
        globalPath: load.global.path,
        ...(load.workspace === undefined ? {} : { workspacePath: load.workspace.path }),
        loadedConnections: resolved.connections.length,
        warnings: resolved.warnings,
      }
    },
    presentCall: () => ({ card: 'generic', title: '重新加载数据库连接配置', kind: 'read' }),
    isConcurrencySafe: () => true,
    timeoutMs: 5000,
  })

  // One-shot connection registration: write the config entry AND verify it in
  // a single call, so the model no longer has to read the config file, hand-
  // write JSON and reload (the flow this tool exists to replace).
  const addConnection = defineTool({
    name: 'db_add_connection',
    description:
      'Add or update one database connection (MySQL / PostgreSQL / SQLite) in a single call: validates the fields, ' +
      'writes the config entry (plaintext `password` is encrypted with AES-256-GCM on the host before it touches disk), ' +
      'and by default immediately tests connectivity and reports latency or the classified failure. ' +
      'An existing connection with the same name is refused unless `replace: true` is passed; when updating without a ' +
      'new `password`, the stored secret is kept. Writes to the global config by default (`scope: "workspace"` targets ' +
      'the current session workspace file instead).',
    parameters: {
      name: { type: 'string', required: true, description: 'Connection name, e.g. "myapp-dev". Must be unique unless replace: true.' },
      dialect: { type: 'string', description: 'One of mysql | postgresql | sqlite. Defaults to mysql.' },
      scope: { type: 'string', description: 'global (default, shared by all workspaces) or workspace (current session workspace file).' },
      host: { type: 'string', description: 'Host name or IP (mysql / postgresql).' },
      port: { type: 'integer', description: 'Port (mysql / postgresql). Defaults to 3306 / 5432 by dialect.' },
      username: { type: 'string', description: 'Database user (mysql / postgresql).' },
      password: {
        type: 'string',
        description:
          'Plaintext password (mysql / postgresql). Encrypted on the host immediately with AES-256-GCM; never stored or returned in plaintext. ' +
          'Omit when updating a connection to keep the password already on disk (a brand-new connection requires it). ' +
          'Prefer having the user set an environment variable and let them put "$ENV:VAR" in the config file by hand when the password must not travel through the conversation.',
      },
      defaultDatabase: { type: 'string', description: 'Default database (mysql / postgresql). For PostgreSQL this is the DATABASE the connection binds to.' },
      file: { type: 'string', description: 'SQLite database file path (required for dialect: sqlite).' },
      mode: { type: 'string', description: 'readonly (default, recommended) or readwrite.' },
      comment: { type: 'string', description: 'Free-form note shown in the settings page.' },
      group: {
        type: 'string',
        description:
          'v0.21: display-only grouping label. Connections sharing it render under one collapsible section in the settings page — ' +
          'use it to keep sibling databases of the same server/project together (for example the server host or the project name).',
      },
      replace: { type: 'boolean', description: 'When true, an existing connection with the same name is updated in place. Defaults to false (refuse). The stored entry is REPLACED wholesale, so pass every optional field you want to keep (comment, group, sshProfile) — an omitted field is cleared, not preserved.' },
      test: { type: 'boolean', description: 'Run a connectivity test right after writing. Defaults to true; pass false to skip.' },
      sshProfile: {
        type: 'string',
        description:
          'FR-13: name of an existing reusable SSH jump-host profile (declared in sshProfiles of the global or workspace config). ' +
          'When set, the database is reached through an SSH tunnel instead of a direct connection (mysql / postgresql only). ' +
          'SSH host-key verification is strict: the jump host key must already be in known_hosts, so the user has to ssh into it once manually first.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          connection: { type: 'string', required: true },
          scope: { type: 'string', required: true, enum: ['global', 'workspace'] },
          action: { type: 'string', enum: ['created', 'replaced'] },
          dialect: { type: 'string', enum: ['mysql', 'postgresql', 'sqlite'] },
          path: { type: 'string' },
          testOk: { type: 'boolean' },
          testLatencyMs: { type: 'integer' },
          testErrorKind: { type: 'string' },
          testMessage: { type: 'string' },
          failureMessage: { type: 'string' },
          failureHint: { type: 'string' },
        },
      } as const,
      render: (_args, value) => {
        const lines: string[] = []
        if (value.failureMessage !== undefined) {
          lines.push(`添加连接失败：${value.failureMessage}`)
          if (value.failureHint !== undefined) lines.push(`建议：${value.failureHint}`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        lines.push(`已${value.action === 'replaced' ? '更新' : '新增'}连接 ${value.connection}（${value.dialect ?? '?'}，${value.scope}）${value.path === undefined ? '' : ` → ${value.path}`}`)
        if (value.testOk === true) lines.push(`连通性：正常（${value.testLatencyMs ?? '?'}ms）`)
        else if (value.testOk === false) lines.push(`连通性：失败 — ${value.testMessage ?? '未知原因'}${value.testErrorKind === undefined ? '' : `（${value.testErrorKind}）`}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const session = resolveSessionInfo(exec)
      const record = (args ?? {}) as Record<string, unknown>
      const name = typeof record.name === 'string' ? record.name.trim() : ''
      const scope: 'global' | 'workspace' = record.scope === 'workspace' ? 'workspace' : 'global'
      const dialectInput = typeof record.dialect === 'string' && record.dialect.length > 0 ? record.dialect : 'mysql'
      const dialectLiteral: 'mysql' | 'postgresql' | 'sqlite' | undefined =
        dialectInput === 'mysql' || dialectInput === 'postgresql' || dialectInput === 'sqlite' ? dialectInput : undefined
      const replace = record.replace === true
      const shouldTest = record.test !== false
      const started = Date.now()

      const fail = (message: string, hint?: string) => {
        deps.audit.record({
          ts: started,
          channel: 'tool',
          action: 'db_add_connection',
          status: 'error',
          ...(name.length === 0 ? {} : { connection: name }),
          detail: `${scope} ${dialectInput} ${message}`,
        })
        return { ok: false, connection: name.length === 0 ? '(未命名)' : name, scope, failureMessage: message, ...(hint === undefined ? {} : { failureHint: hint }) }
      }

      if (name.length === 0) return fail('缺少连接名（name）', '传入一个唯一的连接名，例如 "myapp-dev"')

      // Assemble the same body shape the GUI RPC uses (passwordMode policy etc.).
      const connection: Record<string, unknown> = {
        name,
        dialect: dialectInput,
        mode: typeof record.mode === 'string' && record.mode.length > 0 ? record.mode : 'readonly',
        ...(typeof record.comment === 'string' && record.comment.length > 0 ? { comment: record.comment } : {}),
        // v0.21: optional grouping label (settings-page section).
        ...(typeof record.group === 'string' && record.group.trim().length > 0 ? { group: record.group.trim() } : {}),
      }
      if (dialectInput === 'sqlite') {
        if (typeof record.file !== 'string' || record.file.trim().length === 0) {
          return fail('dialect=sqlite 时必须提供 file（数据库文件路径）', '例如 file: "./data/app.db" 或绝对路径')
        }
        connection.file = record.file.trim()
        connection.passwordMode = 'none'
      } else {
        if (typeof record.host !== 'string' || record.host.trim().length === 0) return fail(`${dialectInput} 连接必须提供 host`)
        if (typeof record.username !== 'string' || record.username.trim().length === 0) return fail(`${dialectInput} 连接必须提供 username`)
        connection.host = record.host.trim()
        connection.username = record.username.trim()
        if (typeof record.port === 'number') connection.port = record.port
        if (typeof record.defaultDatabase === 'string' && record.defaultDatabase.trim().length > 0) connection.defaultDatabase = record.defaultDatabase.trim()
        // FR-13: optional SSH jump host. An unknown name is rejected by
        // config validation at connect time, not silently ignored here.
        if (typeof record.sshProfile === 'string' && record.sshProfile.trim().length > 0) connection.sshProfile = record.sshProfile.trim()
        if (typeof record.password === 'string' && record.password.length > 0) {
          // Plaintext in, ciphertext on disk: saveConnectionInto encrypts it.
          connection.passwordMode = 'plain'
          connection.passwordPlain = record.password
        } else {
          // Keep whatever is already stored (new connections will be rejected
          // by saveConnectionInto with an actionable message).
          connection.passwordMode = 'keep'
        }
      }

      const outcome = saveConnectionInto(
        deps.store,
        { scope, ...(session.cwd === undefined ? {} : { cwd: session.cwd }) },
        { ...(replace ? { originalName: name } : {}), connection },
      )

      if (!outcome.ok) {
        const hint = outcome.warnings !== undefined && outcome.warnings.length > 0
          ? `${outcome.error ?? ''}：${outcome.warnings.join('；')}`
          : undefined
        return fail(outcome.error ?? '写入配置失败', hint)
      }

      // Connectivity check against the freshly written spec (password already
      // in secret form — testConnection resolves it itself).
      let test: ConnectionTestResult | undefined
      if (shouldTest && outcome.spec !== undefined) {
        test = await testConnection(outcome.spec, deps.connectTimeoutMs, session.cwd === undefined ? undefined : { workspaceRoot: session.cwd })
      }

      deps.audit.record({
        ts: started,
        channel: 'tool',
        action: 'db_add_connection',
        status: test !== undefined && !test.ok ? 'error' : 'ok',
        connection: name,
        durationMs: Date.now() - started,
        detail: `${scope} ${outcome.action ?? 'created'} dialect=${dialectInput}${test === undefined ? '' : ` test=${test.ok ? 'ok' : (test.errorKind ?? 'failed')}`}`,
      })

      return {
        ok: true,
        connection: name,
        scope,
        ...(outcome.action === undefined ? {} : { action: outcome.action }),
        dialect: outcome.spec?.dialect ?? dialectLiteral,
        ...(outcome.path === undefined ? {} : { path: outcome.path }),
        ...(test === undefined ? {} : { testOk: test.ok }),
        ...(test?.latencyMs === undefined ? {} : { testLatencyMs: test.latencyMs }),
        ...(test?.errorKind === undefined ? {} : { testErrorKind: test.errorKind }),
        ...(test?.message === undefined ? {} : { testMessage: test.message }),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `添加数据库连接${typeof args?.name === 'string' ? `：${args.name}` : ''}`, kind: 'execute' }),
    isConcurrencySafe: () => false,
    timeoutMs: 30_000,
  })

  // db_query / db_execute audit themselves with rich statement entries; the
  // remaining tools get a generic outcome record so every call leaves a trace.
  const selfAudited = new Set(['db_query', 'db_execute', 'db_add_connection', 'db_read_ssh_log', 'db_search_ssh_logs', 'db_add_ssh_log_source'])
  // FR-22: log tools are opt-out, not opt-in — an empty whitelist already means
  // "no capability", so `logEnabled: false` is only an emergency stop.
  const logTools = deps.logEnabled === false
    ? []
    : buildLogTools({
        store: deps.store,
        audit: deps.audit,
        logMaxBytes: deps.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES,
        logTimeoutMs: deps.logTimeoutMs ?? DEFAULT_LOG_TIMEOUT_MS,
      })
  return [listConnections, testConnectionTool, reloadConfig, addConnection, ...buildMetadataTools(deps), ...buildDataTools(deps), ...logTools].map((tool) => {
    const definition = tool as { name?: string; execute?: (args: unknown, exec: unknown) => Promise<unknown> }
    if (typeof definition.name !== 'string' || typeof definition.execute !== 'function') return tool
    if (selfAudited.has(definition.name)) return tool
    const original = definition.execute
    return {
      ...definition,
      execute: async (args: unknown, exec: unknown) => {
        const started = Date.now()
        const record = (args ?? {}) as { connection?: unknown; database?: unknown }
        const base = {
          ts: started,
          channel: 'tool' as const,
          action: definition.name!,
          ...(typeof record.connection === 'string' ? { connection: record.connection } : {}),
          ...(typeof record.database === 'string' ? { database: record.database } : {}),
        }
        try {
          const result = await original(args, exec)
          const failure = (result as { failureMessage?: unknown }).failureMessage
          deps.audit.record({
            ...base,
            status: failure !== undefined ? 'error' : 'ok',
            durationMs: Date.now() - started,
            ...(typeof failure === 'string' ? { detail: failure } : {}),
          })
          return result
        } catch (error) {
          deps.audit.record({
            ...base,
            status: 'error',
            durationMs: Date.now() - started,
            detail: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
      },
    }
  })
}
