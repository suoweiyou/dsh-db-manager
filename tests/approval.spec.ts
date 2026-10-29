import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../src/config/store.js'
import { AuditLog } from '../src/audit/log.js'
import { classifySql } from '../src/safety/classify.js'
import { issueConfirmToken } from '../src/safety/confirm.js'
import { buildDataTools } from '../src/tools/data.js'
import type { ToolDeps } from '../src/tools/index.js'
import type { PoolManager } from '../src/db/pool.js'
import type { UsageTracker } from '../src/usage.js'

const dirs: string[] = []
const envKeys: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  for (const key of envKeys.splice(0)) delete process.env[key]
})

interface Harness {
  tool: { execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> }
  executed: string[]
  audit: AuditLog
  state: { approvalCalls: number }
}

function makeHarness(requestApproval?: ToolDeps['requestApproval']): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-apv-'))
  dirs.push(dir)
  const globalPath = path.join(dir, 'connections.json')
  fs.writeFileSync(globalPath, JSON.stringify({
    connections: [{ name: 'rw', host: 'h', username: 'u', password: '$ENV:DBM_APV_PW', mode: 'readwrite' }],
  }))
  process.env.DBM_APV_PW = 'pw'
  envKeys.push('DBM_APV_PW')
  const executed: string[] = []
  const state = { approvalCalls: 0 }
  const stubPool = {
    query: async (opts: { sql: string }) => {
      executed.push(opts.sql)
      return [{ affectedRows: 1 }]
    },
    // wrapDriver.run() dispatches to driver.execute for write/DDL verbs —
    // the stub needs that too, otherwise `pool.run('DROP TABLE x')` would
    // throw "driver.execute is not a function".
    execute: async (sql: string, _values?: unknown[]) => {
      executed.push(sql)
      return { affectedRows: 1, rows: [] }
    },
    // M6: db_execute now runs the backup/execute sequence inside a
    // transaction when a backup plan is available. The stub fakes that
    // contract by calling fn with a tx that forwards run() to the same
    // executed[] log, so assertions about `executed` continue to hold.
    withTransaction: async <T,>(fn: (tx: { run: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<T>): Promise<T> => {
      const tx = {
        run: async (sql: string, _values?: unknown[]) => {
          executed.push(sql)
          return { affectedRows: 1, rows: [] }
        },
      }
      return await fn(tx)
    },
  }
  const deps: ToolDeps = {
    store: new ConfigStore({ globalConfigPath: globalPath }),
    pools: { acquire: async () => stubPool } as unknown as PoolManager,
    audit: new AuditLog({ dir: path.join(dir, 'audit'), enabled: true }),
    usage: { record: () => undefined } as unknown as UsageTracker,
    connectTimeoutMs: 1000,
    queryTimeoutMs: 1000,
    maxRows: 200,
    backupEnabled: false,
    backupMaxRows: 100,
    backupDefault: 'small-only',
    backupSmallThreshold: 1000,
    ...(requestApproval === undefined
      ? {}
      : {
          requestApproval: async (req) => {
            state.approvalCalls += 1
            return await requestApproval(req)
          },
        }),
  }
  const tool = buildDataTools(deps).find((t) => (t as { name?: string }).name === 'db_execute') as unknown as Harness['tool']
  return { tool, executed, audit: deps.audit, state }
}

const DANGEROUS_SQL = 'DROP TABLE old_t'

describe('db_execute host approval gate (audit H2 fix)', () => {
  it('executes when the host approval service returns allowed-once', async () => {
    const h = makeHarness(async () => 'allowed-once')
    const result = await h.tool.execute({ sql: DANGEROUS_SQL }, {})
    expect(result.refused).toBe(false)
    expect(result.ok).toBe(true)
    expect(h.executed.some((sql) => /DROP TABLE/i.test(sql))).toBe(true)
    expect(h.state.approvalCalls).toBe(1)
    await h.audit.flush()
    const files = fs.readdirSync(h.audit.dir).filter((f) => f.endsWith('.jsonl'))
    const lines = fs.readFileSync(path.join(h.audit.dir, files[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    const entry = lines.find((l) => l.action === 'db_execute' && l.status === 'ok')
    expect(entry).toBeDefined()
    expect(entry!['approval']).toBe('host-approval')
    expect(entry!['confirmed']).toBe(true)
  })

  it('refuses WITHOUT a token when the user rejects via the approval service', async () => {
    const h = makeHarness(async () => 'rejected')
    const result = await h.tool.execute({ sql: DANGEROUS_SQL }, {})
    expect(result.refused).toBe(true)
    expect(result.reason).toBe('user-rejected')
    expect(result.confirmToken).toBeUndefined()
    expect(h.executed).toHaveLength(0)
  })

  it('treats cancellation like a rejection (no token issued)', async () => {
    const h = makeHarness(async () => 'cancelled')
    const result = await h.tool.execute({ sql: DANGEROUS_SQL }, {})
    expect(result.reason).toBe('user-rejected')
    expect(result.confirmToken).toBeUndefined()
    expect(h.executed).toHaveLength(0)
  })

  it('falls back to the confirm-token loop when no approval service is wired', async () => {
    const h = makeHarness(undefined)
    const result = await h.tool.execute({ sql: DANGEROUS_SQL }, {})
    expect(result.refused).toBe(true)
    expect(result.reason).toBe('dangerous')
    expect(typeof result.confirmToken).toBe('string')
    expect(h.executed).toHaveLength(0)
  })

  it('falls back to the token loop when the approval service errors', async () => {
    const h = makeHarness(async () => {
      throw new Error('no answerer configured')
    })
    const result = await h.tool.execute({ sql: DANGEROUS_SQL }, {})
    expect(result.reason).toBe('dangerous')
    expect(typeof result.confirmToken).toBe('string')
    expect(h.executed).toHaveLength(0)
  })

  it('a valid confirm token executes without calling the approval service', async () => {
    const h = makeHarness(async () => {
      throw new Error('approval must not be called on the token path')
    })
    const stmt = classifySql(DANGEROUS_SQL).statements[0]!
    const issued = issueConfirmToken('rw', stmt.statement)
    const result = await h.tool.execute({ sql: DANGEROUS_SQL, confirmToken: issued.confirmToken }, {})
    expect(result.ok).toBe(true)
    expect(h.executed).toHaveLength(1)
  })
})
