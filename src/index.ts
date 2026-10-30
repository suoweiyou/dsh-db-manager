/**
 * dsh-db-manager — DeepSeek Harness dual-face plugin (host half).
 *
 * Provides a MySQL connection registry (global + per-workspace config files),
 * connectivity tests, model-facing db_* tools, and an HTTP RPC surface that
 * backs the settings-page management GUI. All registrations live on the
 * plugin fiber and are reverted on stop/update.
 *
 * The webServer service mounts in a later composition layer than ordinary
 * plugin rows, so the RPC surface registers through ctx.inject and waits for
 * it; without a webServer (non-web profiles) the callback simply never runs
 * and the model tools keep working.
 */
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { AuditLog } from './audit/log.js'
import { ConfigStore } from './config/store.js'
import { captureBuildInfo } from './rpc/build-info.js'
import { globalDir } from './secrets.js'
import { PoolManager } from './db/pool.js'
import { registerRpc } from './rpc/routes.js'
import { UsageTracker } from './usage.js'
import { buildTools, type ToolDeps } from './tools/index.js'
import type { RequestHumanApproval } from './safety/approval.js'

const name = 'db-manager'
const inject = ['tools']

const Config = z.object({
  globalConfigPath: z.string(),
  connectTimeoutMs: z.number().min(100).default(5000),
  queryTimeoutMs: z.number().min(100).default(15000),
  maxRows: z.number().min(1).default(200),
  backupEnabled: z.boolean().default(true),
  backupMaxRows: z.number().min(1).default(100000),
  // Backup policy (v0.10):
  //   - 'always' (legacy): every UPDATE/DELETE that the safety gateway
  //     classifies as backable gets a __dbm_backup_* table. The operator is
  //     paying the cost of a full-row copy on every write.
  //   - 'small-only' (default since v0.10): back up only when the affected
  //     row estimate is ≤ backupSmallThreshold. Above the threshold we
  //     skip the backup and run the statement directly — this is the safe
  //     default for mixed workloads where a single full-table UPDATE must
  //     not be slowed down by a shadow table copy.
  //   - 'opt-in': never back up unless the caller passes `withBackup: true`.
  //     Strict mode for environments that do their own snapshotting.
  backupDefault: z.union(['always', 'small-only', 'opt-in'] as const).default('small-only'),
  backupSmallThreshold: z.number().min(0).default(1000),
  auditEnabled: z.boolean().default(true),
  rpcEnabled: z.boolean().default(true),
  // FR-22 (v0.22) — read-only SSH log sources. Three knobs only: the output
  // quota (one number, the settings page renders it as a plain input), the
  // per-read timeout, and an emergency stop that unregisters the four tools.
  logEnabled: z.boolean().default(true),
  logMaxBytes: z.number().min(1000).max(1_000_000).default(100_000),
  logTimeoutMs: z.number().min(1000).max(120_000).default(10_000),
})

interface HostContext {
  tools: { register(tool: unknown): () => void }
  get(service: string): unknown
  effect(callback: () => unknown, label?: string): () => void
  inject(deps: string[], callback: (scoped: HostContext) => void): unknown
}

interface ResolvedConfig {
  globalConfigPath?: string
  connectTimeoutMs: number
  queryTimeoutMs: number
  maxRows: number
  backupEnabled: boolean
  backupMaxRows: number
  backupDefault: 'always' | 'small-only' | 'opt-in'
  backupSmallThreshold: number
  auditEnabled: boolean
  rpcEnabled: boolean
  logEnabled: boolean
  logMaxBytes: number
  logTimeoutMs: number
}

/**
 * Duck-typed access to the host ApprovalService (service id 'approval', see
 * @deepseek-ai/dsh-user-approval). Absent or misconfigured service resolves to
 * 'unavailable' so callers fall back to the confirm-token loop instead of
 * failing; a human denial ('rejected'/'cancelled') is always respected.
 */
function approvalRequester(ctx: HostContext): RequestHumanApproval {
  return async (request) => {
    let service: unknown
    try {
      service = ctx.get('approval')
    } catch {
      return 'unavailable'
    }
    const candidate = service as { request?: unknown } | null | undefined
    if (candidate === null || candidate === undefined || typeof candidate.request !== 'function') return 'unavailable'
    try {
      const outcome = await (candidate.request as (req: unknown) => Promise<unknown>)(request)
      return outcome === 'allowed-once' || outcome === 'rejected' || outcome === 'cancelled' ? outcome : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }
}

function apply(ctx: HostContext, config: ResolvedConfig): void {
  const store = new ConfigStore({ globalConfigPath: config.globalConfigPath })
  const pools = new PoolManager()
  const audit = new AuditLog({ dir: path.join(globalDir(), 'audit'), enabled: config.auditEnabled })
  const usage = new UsageTracker({ file: path.join(globalDir(), 'usage.json') })
  // Fingerprint the artifacts this process is loading, so the GUI can tell the
  // user when the code on disk has moved on without a DSH restart.
  const buildInfo = captureBuildInfo()
  ctx.effect(() => () => {
    void pools.closeAll()
    void audit.flush()
    void usage.flush()
  }, 'db-manager: close pools & flush audit/usage')

  const deps: ToolDeps = {
    store,
    pools,
    audit,
    usage,
    connectTimeoutMs: config.connectTimeoutMs,
    queryTimeoutMs: config.queryTimeoutMs,
    maxRows: config.maxRows,
    backupEnabled: config.backupEnabled,
    backupMaxRows: config.backupMaxRows,
    backupDefault: config.backupDefault,
    backupSmallThreshold: config.backupSmallThreshold,
    requestApproval: approvalRequester(ctx),
    logEnabled: config.logEnabled,
    logMaxBytes: config.logMaxBytes,
    logTimeoutMs: config.logTimeoutMs,
  }
  for (const tool of buildTools(deps)) {
    ctx.tools.register(tool)
  }

  if (config.rpcEnabled) {
    ctx.inject(['webServer'], (scoped) => {
      const webServer = scoped.get('webServer') as { register?: unknown } | undefined
      if (webServer === undefined || typeof webServer.register !== 'function') return
      const dispose = registerRpc(scoped as never, webServer as never, { store, connectTimeoutMs: config.connectTimeoutMs, queryTimeoutMs: config.queryTimeoutMs, pools, audit, usage, buildInfo })
      scoped.effect(() => dispose, 'db-manager: rpc routes')
    })
  }
}

export { Config, apply, inject, name }
