/**
 * GUI RPC over the DSH web server: a prefix route plus a per-process random
 * token injected into the page via the webserver/index-inject event. Only the
 * DSH page itself can read the token, so requests from other origins/agents
 * fail closed with 403. Responses never contain credentials.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { AuditLog } from '../audit/log.js'
import { connectionSchema, sshProfileSchema } from '../config/schema.js'
import { workspaceConfigPath, type ConfigStore } from '../config/store.js'
import { connectionsOf, deleteConnection, deleteConnectionFrom, deleteSshProfileFrom, duplicateConnection, moveConnection, saveConnection, saveConnectionInto, saveSshProfileInto } from '../config/mutate.js'
import { buildStatus, type BuildInfo } from './build-info.js'
import { probeSshProfile, SshError } from '../db/ssh-tunnel.js'
import type { PoolManager } from '../db/pool.js'
import { describeTable as describeTableByDialect, listTables, type ColumnInfo, type DescribeResult, type IndexInfo, type TableInfo } from '../db/metadata.js'
import { toDbFailure } from '../db/errors.js'
import { resolvePassword } from '../secrets.js'
import { testConnection } from '../tools/index.js'
import type { UsageTracker } from '../usage.js'
import type { ConnectionSpec, ConnectionTestResult, DbFailure, ConnectionScope, SshProfileSpec } from '../shared/types.js'

export const RPC_BASE_PATH = '/db-manager/api'
export const TOKEN_GLOBAL_NAME = '__DSH_DB_MANAGER_TOKEN__'

export interface RpcDeps {
  store: ConfigStore
  connectTimeoutMs: number
  queryTimeoutMs: number
  pools: PoolManager
  audit?: AuditLog
  usage?: UsageTracker
  /** Fingerprint of the code this process loaded, for the stale-build banner. */
  buildInfo?: BuildInfo
}

function auditMutation(audit: AuditLog | undefined, action: string, connection: string | undefined, status: 'ok' | 'error', detail?: string): void {
  if (audit === undefined) return
  audit.record({ ts: Date.now(), channel: 'rpc', action, status, ...(connection === undefined ? {} : { connection }), detail })
}

/* ── v0.13: GUI table browser (read-only metadata browsing — no row data) ── */

export interface TablesListOutcome {
  ok: boolean
  connection?: string
  dialect?: 'mysql' | 'postgresql' | 'sqlite'
  database?: string
  tables?: TableInfo[]
  failure?: DbFailure
}

export interface TableDescribeOutcome {
  ok: boolean
  connection?: string
  dialect?: 'mysql' | 'postgresql' | 'sqlite'
  database?: string
  table?: string
  columns?: ColumnInfo[]
  indexes?: IndexInfo[]
  ddl?: string
  failure?: DbFailure
}

interface BrowseRuntime {
  pools: PoolManager
  connectTimeoutMs: number
  queryTimeoutMs: number
}

/**
 * Resolve the connection spec for an RPC call. Pulled out of the route
 * handler so unit tests can drive it without the HTTP shell: a missing
 * connection returns `{ ok: false, failure }` mirroring the on-wire shape.
 */
export function resolveSpecForRpc(store: ConfigStore, name: string, workspace?: string): { spec?: ConnectionSpec; failure?: DbFailure } {
  if (name.length === 0) return { failure: { kind: 'config', message: '缺少 connection 参数', hint: '传入要浏览的连接名' } }
  const load = store.load(workspace)
  // Same precedence as the runtime resolver: a project-private connection
  // shadows a global one of the same name, so browsing from the「项目」tab must
  // look in the project file first — otherwise the page would happily show a
  // *different* connection's tables.
  const fromWorkspace = workspace === undefined ? undefined : load.workspace?.data?.connections.find((c) => c.name === name)
  const found = fromWorkspace ?? load.global.data?.connections.find((c) => c.name === name)
  if (found === undefined) {
    return {
      failure: {
        kind: 'config',
        message: workspace === undefined ? `连接 "${name}" 不存在` : `项目连接 "${name}" 不存在（项目：${workspace}）`,
        hint: '调用 connections.list 查看可用连接',
      },
    }
  }
  return { spec: found }
}

/**
 * Open the driver for an RPC metadata call. Mirrors the tool path:
 * resolves the password (env / enc / plain) before acquire so the cached
 * driver key reflects the live secret. SQLite uses process.cwd() as the
 * fallback allowedRoot — same convention as the GUI "测试" button, so a
 * browsing the local workspace's sqlite file is no more permissive than
 * the existing connectivity probe.
 */
async function openForBrowse(
  spec: ConnectionSpec,
  database: string | undefined,
  rt: BrowseRuntime,
  sshProfile?: SshProfileSpec,
): Promise<{ driver?: Awaited<ReturnType<PoolManager['acquire']>>; failure?: DbFailure }> {
  const allowedRoots: ReadonlyArray<string> = [process.cwd()]
  try {
    const resolvedSpec = spec.dialect === 'sqlite'
      ? spec
      : { ...spec, password: resolvePassword(spec.password ?? '') }
    const driver = await rt.pools.acquire(
      resolvedSpec,
      {
        connectTimeoutMs: rt.connectTimeoutMs,
        queryTimeoutMs: rt.queryTimeoutMs,
        allowedRoots,
        ...(sshProfile === undefined ? {} : { sshProfile }),
      },
      database,
    )
    return { driver }
  } catch (error) {
    return { failure: toDbFailure(error) }
  }
}

/**
 * List tables for the settings-page browser. Read-only — never touches
 * data rows. Returns the same `TableInfo` shape as `db_list_tables` so the
 * page can later mirror any tooling-side tweaks without divergence.
 */
export async function browseTablesForRpc(
  store: ConfigStore,
  rt: BrowseRuntime,
  name: string,
  databaseOverride: string | undefined,
  workspace?: string,
): Promise<TablesListOutcome> {
  const resolved = resolveSpecForRpc(store, name, workspace)
  if (resolved.spec === undefined || resolved.failure !== undefined) {
    return { ok: false, failure: resolved.failure }
  }
  const spec = resolved.spec
  const database = databaseOverride ?? spec.defaultDatabase
  if (database === undefined) {
    return {
      ok: false,
      connection: spec.name,
      dialect: spec.dialect,
      failure: { kind: 'config', message: '未指定 database 且连接未配置默认库', hint: '在请求体传入 database，或在连接配置中设置 defaultDatabase' },
    }
  }
  // FR-13: an unresolvable SSH profile is a configuration failure, reported
  // instead of silently connecting directly.
  const ssh = resolveSshFor(store, spec, workspace)
  if (ssh.error !== undefined) {
    return { ok: false, connection: spec.name, dialect: spec.dialect, database, failure: { kind: 'config', message: ssh.error, hint: '检查连接的 sshProfile 名称，或先定义对应的 SSH 配置' } }
  }
  const opened = await openForBrowse(spec, database, rt, ssh.profile)
  if (opened.driver === undefined || opened.failure !== undefined) {
    return { ok: false, connection: spec.name, dialect: spec.dialect, database, failure: opened.failure }
  }
  const driver = opened.driver
  try {
    const tables = await listTables(driver, database)
    return { ok: true, connection: spec.name, dialect: spec.dialect, database, tables }
  } catch (error) {
    return { ok: false, connection: spec.name, dialect: spec.dialect, database, failure: toDbFailure(error) }
  }
  // The driver is owned by PoolManager; releasing here would close the
  // cached connection and break subsequent calls (audit N2 — the cache
  // contract is "open on first acquire, reuse on later acquires").
}

/**
 * Fetch one table's column/index/DDL view. Read-only; same surface as
 * `db_describe_table`. Exported for unit tests so the HTTP shell is not in
 * the path.
 */
export async function describeTableForRpc(
  store: ConfigStore,
  rt: BrowseRuntime,
  name: string,
  table: string,
  databaseOverride: string | undefined,
  workspace?: string,
): Promise<TableDescribeOutcome> {
  const resolved = resolveSpecForRpc(store, name, workspace)
  if (resolved.spec === undefined || resolved.failure !== undefined) {
    return { ok: false, failure: resolved.failure }
  }
  const spec = resolved.spec
  if (table.length === 0) {
    return { ok: false, connection: spec.name, dialect: spec.dialect, failure: { kind: 'config', message: '缺少 table 参数', hint: '传入要查看的表名' } }
  }
  const database = databaseOverride ?? spec.defaultDatabase
  if (database === undefined) {
    return {
      ok: false,
      connection: spec.name,
      dialect: spec.dialect,
      table,
      failure: { kind: 'config', message: '未指定 database 且连接未配置默认库', hint: '在请求体传入 database，或在连接配置中设置 defaultDatabase' },
    }
  }
  const ssh = resolveSshFor(store, spec, workspace)
  if (ssh.error !== undefined) {
    return { ok: false, connection: spec.name, dialect: spec.dialect, database, table, failure: { kind: 'config', message: ssh.error, hint: '检查连接的 sshProfile 名称，或先定义对应的 SSH 配置' } }
  }
  const opened = await openForBrowse(spec, database, rt, ssh.profile)
  if (opened.driver === undefined || opened.failure !== undefined) {
    return { ok: false, connection: spec.name, dialect: spec.dialect, database, table, failure: opened.failure }
  }
  const driver = opened.driver
  try {
    const result: DescribeResult | null = await describeTableByDialect(driver, database, table)
    if (result === null) {
      return {
        ok: false,
        connection: spec.name,
        dialect: spec.dialect,
        database,
        table,
        failure: { kind: 'config', message: `表 ${table} 不存在（或无权限查看）`, hint: '用 tables.list 核对表名' },
      }
    }
    return {
      ok: true,
      connection: spec.name,
      dialect: spec.dialect,
      database,
      table,
      columns: result.columns,
      indexes: result.indexes,
      ...(result.ddl === undefined ? {} : { ddl: result.ddl }),
    }
  } catch (error) {
    return { ok: false, connection: spec.name, dialect: spec.dialect, database, table, failure: toDbFailure(error) }
  }
}

interface StoredStatus {
  name: string
  ok: boolean
  latencyMs?: number
  errorKind?: string
  message?: string
  hint?: string
  testedAt: number
}

/**
 * Verdicts are keyed by scope + name — the same rule the GUI uses for its per-card
 * state. A project connection may share a name with a global one (v0.18), so a
 * name-only cache hands the wrong verdict to a card. `\u241f` (unit separator)
 * cannot occur in a connection name or a workspace path.
 */
function statusKey(scope: ConnectionScope, name: string, workspace?: string): string {
  return scope === 'workspace' && workspace !== undefined ? `w\u241f${workspace}\u241f${name}` : `g\u241f${name}`
}

/** Last test results, surfaced to the GUI status view. */
const statusCache = new Map<string, ConnectionTestResult>()

export function statusSnapshot(): ConnectionTestResult[] {
  return [...statusCache.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Register the RPC route + page token injection. Returns a combined disposer. */
export function registerRpc(ctx: Context, webServer: WebServer, deps: RpcDeps): () => void {
  const token = randomBytes(32).toString('base64url')
  const offInject = ctx.on('webserver/index-inject', (table: Array<{ kind: string; name?: string; value?: unknown }>) => {
    table.push({ kind: 'global', name: TOKEN_GLOBAL_NAME, value: token })
  })
  const route: WebRoute = {
    kind: 'prefix',
    path: RPC_BASE_PATH,
    handler: (req, res) => {
      void handleRpc(req, res, token, deps).catch(() => {
        sendJson(res, 500, { error: '内部错误' })
      })
    },
  }
  const disposeRoute = webServer.register(route)
  return () => {
    disposeRoute()
    offInject()
  }
}

/** Constant-time token comparison (audit N7, 2nd round): keep the header
 *  check on the same standard as the HMAC verification in safety/confirm. */
function tokenMatches(header: unknown, token: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const provided = Buffer.from(header, 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

async function handleRpc(req: IncomingMessage, res: ServerResponse, token: string, deps: RpcDeps): Promise<void> {
  const method = req.url?.slice(RPC_BASE_PATH.length + 1).split('?')[0] ?? ''
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '仅支持 POST' })
    return
  }
  if (!tokenMatches(req.headers['x-dbm-token'], token)) {
    sendJson(res, 403, { error: '令牌缺失或不匹配：请从 DSH 设置页打开（刷新页面后重试）' })
    return
  }
  let body: Record<string, unknown> = {}
  try {
    const raw = await readBody(req, 1_000_000)
    if (raw.length > 0) body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    sendJson(res, 400, { error: '请求体必须是合法 JSON（≤ 1MB）' })
    return
  }
  try {
    switch (method) {
      case 'build.status': {
        // Lets the page detect that the running host is older/newer than the
        // code on disk (Host-half changes need a DSH restart to take effect).
        if (deps.buildInfo === undefined) {
          sendJson(res, 200, { available: false })
          return
        }
        const status = buildStatus(deps.buildInfo)
        sendJson(res, 200, {
          available: true,
          libDir: status.libDir,
          loadedAt: status.loadedAt,
          loadedHash: status.loaded?.hash ?? null,
          currentHash: status.current?.hash ?? null,
          files: status.current?.files ?? 0,
          newestMtimeMs: status.current?.newestMtimeMs ?? 0,
          stale: status.stale,
        })
        return
      }
      case 'sshProfiles.test': {
        // Validate one SSH configuration end to end (reachability + strict host
        // key verification + authentication). No port forwarding is attempted,
        // so success means the credentials/known_hosts entry are right.
        const wanted = typeof body.name === 'string' ? body.name : ''
        const wantsWorkspace = typeof body.workspace === 'string' && body.workspace.length > 0
        const wsTarget = wantsWorkspace ? resolveKnownWorkspace(deps.usage, body.workspace) : { path: undefined as string | undefined }
        if (wantsWorkspace && wsTarget.path === undefined) {
          sendJson(res, 422, { error: wsTarget.error })
          return
        }
        const load = deps.store.load(wsTarget.path)
        const profiles = [...(load.workspace?.data?.sshProfiles ?? []), ...(load.global.data?.sshProfiles ?? [])]
        const profile = profiles.find((entry) => entry.name === wanted)
        const testedAt = Date.now()
        if (profile === undefined) {
          auditMutation(deps.audit, 'sshProfiles.test', wanted, 'error', 'SSH 配置不存在')
          sendJson(res, 404, { error: `SSH 配置 "${wanted}" 不存在` })
          return
        }
        try {
          const probe = await probeSshProfile(profile)
          auditMutation(deps.audit, 'sshProfiles.test', wanted, 'ok', `${probe.endpoint} ${profile.auth.method}`)
          sendJson(res, 200, { result: { name: wanted, ok: true, latencyMs: probe.latencyMs, testedAt } })
        } catch (error) {
          const failure = toDbFailure(error)
          auditMutation(deps.audit, 'sshProfiles.test', wanted, 'error', failure.message)
          // Always 200 with the verdict inside `result`, matching
          // `connections.test` — the page renders both success and failure from
          // the same shape instead of having to parse an error envelope.
          sendJson(res, 200, {
            result: {
              name: wanted,
              ok: false,
              errorKind: failure.kind,
              message: sanitize(failure.message),
              ...(failure.hint === undefined ? {} : { hint: sanitize(failure.hint) }),
              testedAt,
            },
          })
        }
        return
      }
      case 'connections.list':
        sendJson(res, 200, { connections: listViews(deps.store), sshProfiles: globalSshProfileViews(deps.store), warnings: globalWarnings(deps.store) })
        return
      case 'sshProfiles.save': {
        // Global by default; a validated workspace path targets the project file.
        const scopeTarget = typeof body.workspace === 'string' && body.workspace.length > 0
          ? resolveKnownWorkspace(deps.usage, body.workspace)
          : { path: undefined as string | undefined }
        if (typeof body.workspace === 'string' && body.workspace.length > 0 && scopeTarget.path === undefined) {
          sendJson(res, 422, { error: scopeTarget.error })
          return
        }
        const target = scopeTarget.path === undefined
          ? { scope: 'global' as const }
          : { scope: 'workspace' as const, cwd: scopeTarget.path }
        const outcome = saveSshProfileInto(deps.store, target, body)
        if (outcome.ok) {
          auditMutation(deps.audit, 'sshProfiles.save', outcome.name, 'ok', `scope=${target.scope} action=${outcome.action ?? 'created'}`)
          sendJson(res, 200, { ok: true, name: outcome.name, action: outcome.action, path: outcome.path })
        } else {
          auditMutation(deps.audit, 'sshProfiles.save', typeof body.originalName === 'string' ? body.originalName : undefined, 'error', outcome.error)
          sendJson(res, 422, { error: outcome.error, warnings: outcome.warnings })
        }
        return
      }
      case 'sshProfiles.delete': {
        const name = typeof body.name === 'string' ? body.name : ''
        const wantsWorkspace = typeof body.workspace === 'string' && body.workspace.length > 0
        const wsTarget = wantsWorkspace ? resolveKnownWorkspace(deps.usage, body.workspace) : { path: undefined as string | undefined }
        if (wantsWorkspace && wsTarget.path === undefined) {
          sendJson(res, 422, { error: wsTarget.error })
          return
        }
        const outcome = deleteSshProfileFrom(
          deps.store,
          wsTarget.path === undefined ? { scope: 'global' } : { scope: 'workspace', cwd: wsTarget.path },
          name,
        )
        if (outcome.ok) {
          auditMutation(deps.audit, 'sshProfiles.delete', name, 'ok', `scope=${wsTarget.path === undefined ? 'global' : 'workspace'}`)
          sendJson(res, 200, { ok: true, path: outcome.path })
        } else {
          auditMutation(deps.audit, 'sshProfiles.delete', name, 'error', outcome.error)
          sendJson(res, 404, { error: outcome.error })
        }
        return
      }
      case 'workspaces.list':
        sendJson(res, 200, { workspaces: workspaceViews(deps.store, deps.usage) })
        return
      case 'workspaces.save': {
        const target = resolveKnownWorkspace(deps.usage, body.workspace)
        if (target.path === undefined) {
          sendJson(res, 422, { error: target.error })
          return
        }
        const outcome = saveConnectionInto(deps.store, { scope: 'workspace', cwd: target.path }, body)
        const label = typeof body.originalName === 'string' ? body.originalName : undefined
        if (outcome.ok) {
          auditMutation(deps.audit, 'workspaces.save', outcome.name, 'ok', `workspace=${target.path} action=${outcome.action ?? 'created'}`)
          sendJson(res, 200, { ok: true, name: outcome.name, action: outcome.action, workspace: target.path, path: outcome.path })
        } else {
          auditMutation(deps.audit, 'workspaces.save', label, 'error', `workspace=${target.path} ${outcome.error ?? ''}`)
          sendJson(res, 422, { error: outcome.error, warnings: outcome.warnings })
        }
        return
      }
      case 'workspaces.delete': {
        const target = resolveKnownWorkspace(deps.usage, body.workspace)
        if (target.path === undefined) {
          sendJson(res, 422, { error: target.error })
          return
        }
        const name = typeof body.name === 'string' ? body.name : ''
        const outcome = deleteConnectionFrom(deps.store, { scope: 'workspace', cwd: target.path }, name)
        if (outcome.ok) {
          auditMutation(deps.audit, 'workspaces.delete', name, 'ok', `workspace=${target.path}`)
          sendJson(res, 200, { ok: true, workspace: target.path, path: outcome.path })
        } else {
          auditMutation(deps.audit, 'workspaces.delete', name, 'error', `workspace=${target.path} ${outcome.error ?? ''}`)
          sendJson(res, 404, { error: outcome.error })
        }
        return
      }
      case 'connections.usage':
        sendJson(res, 200, { usage: deps.usage === undefined ? {} : deps.usage.snapshot() })
        return
      case 'connections.status':
        sendJson(res, 200, { results: statusSnapshot() })
        return
      case 'connections.test': {
        const name = typeof body.name === 'string' ? body.name : ''
        // Optional workspace target so the GUI can test a single project-private
        // connection, including the batched「全部测试」sweep (v0.22: the page drives
        // the batch at concurrency 4 and folds each verdict in as it lands).
        let spec: ConnectionSpec | undefined
        let scopeCwd: string | undefined
        if (typeof body.workspace === 'string' && body.workspace.length > 0) {
          const target = resolveKnownWorkspace(deps.usage, body.workspace)
          if (target.path === undefined) {
            sendJson(res, 422, { error: target.error })
            return
          }
          scopeCwd = target.path
          spec = findWorkspaceSpec(deps.store, target.path, name)
        } else {
          spec = findSpec(deps.store, name)
        }
        if (spec === undefined) {
          sendJson(res, 404, { error: `连接 "${name}" 不存在` })
          return
        }
        const ssh = resolveSshFor(deps.store, spec, scopeCwd)
        if (ssh.error !== undefined) {
          sendJson(res, 422, { error: ssh.error })
          return
        }
        const scope: ConnectionScope = scopeCwd === undefined ? 'global' : 'workspace'
        const probe = await testConnection(spec, deps.connectTimeoutMs, {
          ...(scopeCwd === undefined ? {} : { workspaceRoot: scopeCwd }),
          ...(ssh.profile === undefined ? {} : { sshProfile: ssh.profile }),
        })
        const result: ConnectionTestResult = {
          ...probe,
          scope,
          ...(scopeCwd === undefined ? {} : { workspace: scopeCwd }),
        }
        statusCache.set(statusKey(scope, name, scopeCwd), result)
        sendJson(res, 200, { result })
        return
      }
      case 'connections.duplicate': {
        // Copy one connection, keeping its stored secret (v0.21) — the fast path
        // for a server that hosts several databases. The copy lands next to the
        // source by default; `toWorkspace` relocates it, and both ends go
        // through the same fail-closed workspace whitelist as move.
        const fromWorkspace = typeof body.fromWorkspace === 'string' && body.fromWorkspace.length > 0 ? body.fromWorkspace : undefined
        const toWorkspace = typeof body.toWorkspace === 'string' && body.toWorkspace.length > 0 ? body.toWorkspace : undefined
        let fromCwd: string | undefined
        if (fromWorkspace !== undefined) {
          const resolved = resolveKnownWorkspace(deps.usage, fromWorkspace)
          if (resolved.path === undefined) {
            sendJson(res, 422, { error: resolved.error })
            return
          }
          fromCwd = resolved.path
        }
        let toCwd: string | undefined
        if (toWorkspace !== undefined) {
          const resolved = resolveKnownWorkspace(deps.usage, toWorkspace)
          if (resolved.path === undefined) {
            sendJson(res, 422, { error: resolved.error })
            return
          }
          toCwd = resolved.path
        }
        const source = fromCwd === undefined ? { scope: 'global' as const } : { scope: 'workspace' as const, cwd: fromCwd }
        const target = toCwd === undefined ? source : { scope: 'workspace' as const, cwd: toCwd }
        const outcome = duplicateConnection(deps.store, source, target, body)
        if (outcome.ok) {
          auditMutation(deps.audit, 'connections.duplicate', outcome.name, 'ok', `from=${typeof body.originalName === 'string' ? body.originalName : '?'} to=${toCwd === undefined ? 'same' : toCwd}`)
          sendJson(res, 200, { ok: true, name: outcome.name, action: outcome.action })
        } else {
          auditMutation(deps.audit, 'connections.duplicate', typeof body.originalName === 'string' ? body.originalName : undefined, 'error', outcome.error)
          sendJson(res, 422, { error: outcome.error, warnings: outcome.warnings })
        }
        return
      }
      case 'connections.move': {
        // Move one connection between the global file and a project file (or
        // between two projects) — the「编辑时更改所属」feature. Both ends go
        // through the same fail-closed workspace whitelist.
        const fromWorkspace = typeof body.fromWorkspace === 'string' && body.fromWorkspace.length > 0 ? body.fromWorkspace : undefined
        const toWorkspace = typeof body.toWorkspace === 'string' && body.toWorkspace.length > 0 ? body.toWorkspace : undefined
        let fromCwd: string | undefined
        if (fromWorkspace !== undefined) {
          const resolved = resolveKnownWorkspace(deps.usage, fromWorkspace)
          if (resolved.path === undefined) {
            sendJson(res, 422, { error: resolved.error })
            return
          }
          fromCwd = resolved.path
        }
        let toCwd: string | undefined
        if (toWorkspace !== undefined) {
          const resolved = resolveKnownWorkspace(deps.usage, toWorkspace)
          if (resolved.path === undefined) {
            sendJson(res, 422, { error: resolved.error })
            return
          }
          toCwd = resolved.path
        }
        const outcome = moveConnection(
          deps.store,
          fromCwd === undefined ? { scope: 'global' } : { scope: 'workspace', cwd: fromCwd },
          toCwd === undefined ? { scope: 'global' } : { scope: 'workspace', cwd: toCwd },
          body,
        )
        if (outcome.ok) {
          const detail = `from=${fromCwd === undefined ? 'global' : fromCwd} to=${toCwd === undefined ? 'global' : toCwd} action=${outcome.action ?? 'moved'}${outcome.warning === undefined ? '' : ` warning=${outcome.warning}`}`
          auditMutation(deps.audit, 'connections.move', outcome.name, 'ok', detail)
          sendJson(res, 200, {
            ok: true,
            name: outcome.name,
            action: outcome.action,
            ...(outcome.warning === undefined ? {} : { warning: sanitize(outcome.warning) }),
          })
        } else {
          auditMutation(deps.audit, 'connections.move', typeof body.originalName === 'string' ? body.originalName : undefined, 'error', outcome.error)
          sendJson(res, 422, { error: outcome.error, warnings: outcome.warnings })
        }
        return
      }
      case 'connections.save': {
        const outcome = saveConnection(deps.store, body)
        if (outcome.ok) {
          auditMutation(deps.audit, 'connections.save', outcome.name, 'ok')
          sendJson(res, 200, { ok: true, name: outcome.name })
        } else {
          auditMutation(deps.audit, 'connections.save', typeof body.originalName === 'string' ? body.originalName : undefined, 'error', outcome.error)
          sendJson(res, 422, { error: outcome.error, warnings: outcome.warnings })
        }
        return
      }
      case 'connections.delete': {
        const name = typeof body.name === 'string' ? body.name : ''
        const outcome = deleteConnection(deps.store, name)
        if (outcome.ok) {
          statusCache.delete(name)
          auditMutation(deps.audit, 'connections.delete', name, 'ok')
          sendJson(res, 200, { ok: true })
        } else {
          auditMutation(deps.audit, 'connections.delete', name, 'error', outcome.error)
          sendJson(res, 404, { error: outcome.error })
        }
        return
      }
      case 'tables.list': {
        const name = typeof body.name === 'string' ? body.name : ''
        const database = typeof body.database === 'string' && body.database.length > 0 ? body.database : undefined
        // v0.18: optional project target so the「项目」tab can browse the tables
        // of a project-private connection with the very same card.
        const wantedWorkspace = typeof body.workspace === 'string' && body.workspace.length > 0 ? body.workspace : undefined
        const wsTarget = wantedWorkspace === undefined ? { path: undefined as string | undefined } : resolveKnownWorkspace(deps.usage, wantedWorkspace)
        if (wantedWorkspace !== undefined && wsTarget.path === undefined) {
          sendJson(res, 422, { ok: false, error: wsTarget.error })
          return
        }
        const outcome = await browseTablesForRpc(deps.store, { pools: deps.pools, connectTimeoutMs: deps.connectTimeoutMs, queryTimeoutMs: deps.queryTimeoutMs }, name, database, wsTarget.path)
        if (outcome.ok) {
          deps.audit?.record({ ts: Date.now(), channel: 'rpc', action: 'tables.list', status: 'ok', connection: outcome.connection, database: outcome.database, detail: `${outcome.tables?.length ?? 0} 个表${wsTarget.path === undefined ? '' : `（项目 ${wsTarget.path}）`}` })
          sendJson(res, 200, { ok: true, connection: outcome.connection, dialect: outcome.dialect, database: outcome.database, tables: outcome.tables })
        } else {
          deps.audit?.record({ ts: Date.now(), channel: 'rpc', action: 'tables.list', status: 'error', ...(outcome.connection === undefined ? {} : { connection: outcome.connection }), ...(outcome.database === undefined ? {} : { database: outcome.database }), detail: outcome.failure?.message })
          const httpStatus = outcome.failure?.kind === 'config' ? 422 : 502
          sendJson(res, httpStatus, { ok: false, connection: outcome.connection, dialect: outcome.dialect, ...(outcome.database === undefined ? {} : { database: outcome.database }), error: sanitize(outcome.failure?.message ?? '未知错误'), hint: outcome.failure?.hint === undefined ? undefined : sanitize(outcome.failure.hint) })
        }
        return
      }
      case 'tables.describe': {
        const name = typeof body.name === 'string' ? body.name : ''
        const table = typeof body.table === 'string' ? body.table : ''
        const database = typeof body.database === 'string' && body.database.length > 0 ? body.database : undefined
        const wantedWorkspace = typeof body.workspace === 'string' && body.workspace.length > 0 ? body.workspace : undefined
        const wsTarget = wantedWorkspace === undefined ? { path: undefined as string | undefined } : resolveKnownWorkspace(deps.usage, wantedWorkspace)
        if (wantedWorkspace !== undefined && wsTarget.path === undefined) {
          sendJson(res, 422, { ok: false, error: wsTarget.error })
          return
        }
        const outcome = await describeTableForRpc(deps.store, { pools: deps.pools, connectTimeoutMs: deps.connectTimeoutMs, queryTimeoutMs: deps.queryTimeoutMs }, name, table, database, wsTarget.path)
        if (outcome.ok) {
          deps.audit?.record({ ts: Date.now(), channel: 'rpc', action: 'tables.describe', status: 'ok', connection: outcome.connection, database: outcome.database, detail: outcome.table })
          sendJson(res, 200, { ok: true, connection: outcome.connection, dialect: outcome.dialect, database: outcome.database, table: outcome.table, columns: outcome.columns, indexes: outcome.indexes, ...(outcome.ddl === undefined ? {} : { ddl: outcome.ddl }) })
        } else {
          deps.audit?.record({ ts: Date.now(), channel: 'rpc', action: 'tables.describe', status: 'error', ...(outcome.connection === undefined ? {} : { connection: outcome.connection }), ...(outcome.database === undefined ? {} : { database: outcome.database }), detail: outcome.failure?.message })
          const httpStatus = outcome.failure?.kind === 'config' ? 422 : 502
          sendJson(res, httpStatus, { ok: false, connection: outcome.connection, dialect: outcome.dialect, ...(outcome.database === undefined ? {} : { database: outcome.database }), ...(outcome.table === undefined ? {} : { table: outcome.table }), error: sanitize(outcome.failure?.message ?? '未知错误'), hint: outcome.failure?.hint === undefined ? undefined : sanitize(outcome.failure.hint) })
        }
        return
      }
      default:
        sendJson(res, 404, { error: `未知 RPC 方法 "${method}"` })
    }
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? sanitize(error.message) : '内部错误' })
  }
}

/* ── config reads for the GUI view (mutations live in config/mutate.ts) ── */

/**
 * GUI list of the global connections, shaped for the page (no credentials).
 * Uses the ConfigStore's mtime-cached load so repeated RPC calls do not
 * re-read/re-validate the file; `raw` keeps unvalidated entries listable as
 * "invalid" cards. `ConnectionView` is shared with the workspace view.
 */
function connectionView(entry: Record<string, unknown>, scope: 'global' | 'workspace'): Record<string, unknown> {
  const parsed = connectionSchema.safeParse(entry)
  if (!parsed.success) return { name: String((entry as { name?: unknown })?.name ?? '(未命名)'), scope, invalid: true }
  const c = parsed.data
  // discriminatedUnion narrows the union here: `c.dialect === 'sqlite'` keeps
  // only the sqlite branch (with `file`), the other branches carry the
  // server-style fields. We still spread the optional defaultDatabase /
  // comment uniformly across both.
  const base = {
    name: c.name,
    dialect: c.dialect,
    ...(c.defaultDatabase === undefined ? {} : { defaultDatabase: c.defaultDatabase }),
    mode: c.mode,
    ...(c.comment === undefined ? {} : { comment: c.comment }),
    // v0.21: display-only grouping label; the page renders one collapsible
    // section per value.
    ...(c.group === undefined ? {} : { group: c.group }),
    scope,
  }
  if (c.dialect === 'sqlite') {
    return { ...base, file: c.file, port: c.port, hasPassword: false }
  }
  return {
    ...base,
    host: c.host,
    port: c.port,
    username: c.username,
    hasPassword: c.password !== undefined,
    // FR-13: which SSH jump host (if any) this connection goes through.
    ...(c.sshProfile === undefined ? {} : { sshProfile: c.sshProfile }),
  }
}

/**
 * Credential-free view of one SSH profile (FR-13): the page only needs to know
 * which secrets exist (`has*`), never their values.
 */
function sshProfileView(entry: Record<string, unknown>, scope: 'global' | 'workspace'): Record<string, unknown> {
  const parsed = sshProfileSchema.safeParse(entry)
  if (!parsed.success) return { name: String((entry as { name?: unknown })?.name ?? '(未命名)'), scope, invalid: true }
  const p = parsed.data
  return {
    name: p.name,
    scope,
    host: p.host,
    port: p.port ?? 22,
    username: p.username,
    authMethod: p.auth.method,
    ...(p.auth.keyPath === undefined ? {} : { keyPath: p.auth.keyPath }),
    hasPrivateKey: p.auth.privateKey !== undefined,
    hasPassphrase: p.auth.passphrase !== undefined,
    hasPassword: p.auth.password !== undefined,
    ...(p.knownHostsPath === undefined ? {} : { knownHostsPath: p.knownHostsPath }),
    // FR-22: the editor needs the actual whitelist to round-trip it (it is not a
    // secret — paths and unit names only), and the card shows the count.
    logSourceCount: p.logSources?.length ?? 0,
    ...(p.logSources === undefined
      ? {}
      : {
          logSources: p.logSources.map((source) => ({
            name: source.name,
            kind: source.kind,
            ...(source.path === undefined ? {} : { path: source.path }),
            ...(source.unit === undefined ? {} : { unit: source.unit }),
            ...(source.label === undefined ? {} : { label: source.label }),
            ...(source.via === undefined ? {} : { via: source.via }),
          })),
        }),
  }
}

function globalSshProfileViews(store: ConfigStore): Array<Record<string, unknown>> {
  const load = store.load()
  return rawSshProfiles(load.global).map((entry) => sshProfileView(entry, 'global'))
}

function rawConnectionEntries(load: { raw?: unknown }): Array<Record<string, unknown>> {
  return connectionsOf(load.raw)
}

/** Raw (unvalidated) sshProfiles entries from a loaded config file. */
function rawSshProfiles(load: { raw?: unknown }): Array<Record<string, unknown>> {
  const profiles = (load.raw as { sshProfiles?: unknown } | null | undefined)?.sshProfiles
  return Array.isArray(profiles) ? (profiles as Array<Record<string, unknown>>) : []
}

function findSpec(store: ConfigStore, name: string): ConnectionSpec | undefined {
  const load = store.load()
  return load.global.data?.connections.find((c) => c.name === name)
}

/** Look up one connection declared in a workspace (project) file. */
function findWorkspaceSpec(store: ConfigStore, wsPath: string, name: string): ConnectionSpec | undefined {
  const load = store.load(wsPath)
  return load.workspace?.data?.connections.find((c) => c.name === name)
}

/**
 * FR-13: resolve the SSH profile a connection references. A missing profile is
 * a hard configuration error — callers must never fall back to a direct
 * connection, which would silently bypass the tunnel.
 */
function resolveSshFor(
  store: ConfigStore,
  spec: ConnectionSpec,
  cwd?: string,
): { profile?: SshProfileSpec; error?: string } {
  if (spec.sshProfile === undefined) return {}
  return store.resolveSshProfile(store.load(cwd), spec)
}

function listViews(store: ConfigStore): Array<Record<string, unknown>> {
  return rawConnectionEntries(store.load().global).map((entry) => connectionView(entry, 'global'))
}

/* ── workspace (项目) views ──────────────────────────────────────────────── */

/**
 * The「项目」tab's data. The project list is whatever this process has actually
 * observed — persisted usage workspaces plus live session cwds — so the plugin
 * never scans the disk for projects the user never used here.
 */
function workspaceViews(store: ConfigStore, usage: UsageTracker | undefined): Array<Record<string, unknown>> {
  const snapshot = usage === undefined ? {} : usage.snapshot()
  const paths = usage === undefined ? [] : usage.workspacePaths()
  return paths.map((wsPath) => {
    const load = store.load(wsPath)
    const ws = load.workspace
    const entries = ws === undefined ? [] : connectionsOf(ws.raw)
    const globalUsage = Object.entries(snapshot)
      .map(([name, entry]) => {
        const hit = entry.workspaces.find((item) => item.path === wsPath)
        return hit === undefined ? undefined : { name, count: hit.count, lastUsedAt: hit.lastUsedAt }
      })
      .filter((item): item is { name: string; count: number; lastUsedAt: number } => item !== undefined)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    return {
      path: wsPath,
      configPath: ws?.path ?? workspaceConfigPath(wsPath),
      exists: ws?.exists === true,
      connections: entries.map((entry) => connectionView(entry, 'workspace')),
      /** SSH profiles declared by this project (FR-13), credentials stripped. */
      sshProfiles: (ws === undefined ? [] : rawSshProfiles(ws)).map((entry) => sshProfileView(entry, 'workspace')),
      warnings: ws?.warnings ?? [],
      ...(ws?.data?.useGlobal === undefined ? {} : { useGlobal: ws.data.useGlobal }),
      ...(ws?.data?.default === undefined ? {} : { defaultConnection: ws.data.default }),
      ...(ws?.exists === true && ws.data === undefined ? { invalid: true } : {}),
      ...(globalUsage.length === 0 ? {} : { globalUsage }),
    }
  })
}

/**
 * Mutations accept a workspace path from the page, so it must be validated
 * against what the tracker has actually seen. Without this a token-holding page
 * could write `<anywhere>/.dsh/db-manager.json` — the GUI may only manage
 * projects it already knows about (fail-closed). Exported for tests.
 */
export function resolveKnownWorkspace(usage: UsageTracker | undefined, raw: unknown): { path?: string; error?: string } {
  const candidate = typeof raw === 'string' ? raw.trim() : ''
  if (candidate.length === 0) return { error: '缺少工作区路径（workspace）' }
  if (usage === undefined) return { error: '使用关联追踪不可用，无法校验工作区路径，本次变更被拒绝' }
  if (!usage.knowsWorkspace(candidate)) {
    return { error: `未知工作区 "${candidate}"：只能管理本插件观察到的项目（请先在该项目的会话中调用任一 db_* 工具）` }
  }
  return { path: candidate }
}

function globalWarnings(store: ConfigStore): string[] {
  return store.load().global.warnings
}

/**
 * v0.22: the host no longer fans out a batch test. Two reasons:
 *
 * 1. the page could not show partial progress — it got one JSON body after the whole
 *    sweep, so a slow list looked frozen and a client-side 30s abort threw away every
 *    verdict that had already been computed;
 * 2. the batch hid its own timeout policy (`min(connectTimeoutMs, 2s)`), so a
 *    connection that passed the single test reported "连接超时" here.
 *
 * 「全部测试」now runs as `connections.test` × N from the page at concurrency 4,
 * folding each verdict into the card as it lands (`Section.ts#testAll`).
 */

/** Strip accidental secret-looking fragments from error strings before they reach the page. */
function sanitize(message: string): string {
  return message.replace(/\$ENV:[A-Za-z_][A-Za-z0-9_]*/g, '$ENV:***').replace(/enc:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/g, 'enc:v1:***')
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}
