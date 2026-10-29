/**
 * db_add_connection (v0.14): one-call connection registration.
 *
 * Covers the config-write layer (config/mutate.ts scope handling) and the
 * model-facing tool behaviour: plaintext password reaching disk only as
 * ciphertext, name-collision refusal vs `replace`, workspace vs global
 * target, secret retention on update, and the audit trail.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuditLog } from '../src/audit/log.js'
import { saveConnectionInto } from '../src/config/mutate.js'
import { ConfigStore } from '../src/config/store.js'
import { PoolManager } from '../src/db/pool.js'
import { buildTools } from '../src/tools/index.js'
import { UsageTracker } from '../src/usage.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

interface Harness {
  store: ConfigStore
  auditDir: string
  workspace: string
  globalPath: string
  tool: { execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>; name: string }
  exec: unknown
}

function harness(): Harness {
  const root = tmpDir('dbm-add-')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  const globalPath = path.join(root, 'global', 'connections.json')
  const auditDir = path.join(root, 'audit')
  const store = new ConfigStore({ globalConfigPath: globalPath })
  const tools = buildTools({
    store,
    pools: new PoolManager(),
    audit: new AuditLog({ dir: auditDir, enabled: true }),
    usage: new UsageTracker({ file: path.join(root, 'usage.json') }),
    connectTimeoutMs: 300,
    queryTimeoutMs: 300,
    maxRows: 50,
    backupEnabled: true,
    backupMaxRows: 100000,
    backupDefault: 'small-only',
    backupSmallThreshold: 1000,
  })
  const tool = tools.find((t) => (t as { name?: string }).name === 'db_add_connection') as Harness['tool']
  if (tool === undefined) throw new Error('db_add_connection tool not registered')
  // exec shape mirrors what the host passes: agent.session.header.cwd
  const exec = { agent: { id: 'session-1', session: { id: 'session-1', header: { cwd: workspace } } } }
  return { store, auditDir, workspace, globalPath, tool, exec }
}

function readConnections(file: string): Array<Record<string, unknown>> {
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { connections?: Array<Record<string, unknown>> }).connections ?? []
}

function auditEntries(dir: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>))
}

describe('db_add_connection — one-call registration', () => {
  it('creates a mysql connection and stores the password as ciphertext only', async () => {
    const h = harness()
    const result = await h.tool.execute({
      name: 'app-dev',
      dialect: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      username: 'app_ro',
      password: 'sup3r-secret-pw',
      defaultDatabase: 'app_db',
      test: false,
    }, h.exec)

    expect(result.ok).toBe(true)
    expect(result.action).toBe('created')
    expect(result.scope).toBe('global')

    const raw = fs.readFileSync(h.globalPath, 'utf8')
    const entry = readConnections(h.globalPath)[0]!
    expect(entry['name']).toBe('app-dev')
    expect(entry['host']).toBe('127.0.0.1')
    expect(entry['mode']).toBe('readonly')
    expect(String(entry['password'])).toMatch(/^enc:v1:/)
    // The plaintext must not appear anywhere in the file or the tool result.
    expect(raw).not.toContain('sup3r-secret-pw')
    expect(JSON.stringify(result)).not.toContain('sup3r-secret-pw')
  })

  it('refuses a duplicate name unless replace is set, then updates in place keeping the stored secret', async () => {
    const h = harness()
    const base = { name: 'dup', dialect: 'mysql', host: 'h1', username: 'u', password: 'pw-1', test: false }
    expect((await h.tool.execute(base, h.exec)).ok).toBe(true)

    const conflict = await h.tool.execute({ ...base, host: 'h2' }, h.exec)
    expect(conflict.ok).toBe(false)
    expect(String(conflict.failureMessage)).toContain('已存在同名连接')

    const updated = await h.tool.execute({ name: 'dup', dialect: 'mysql', host: 'h2', username: 'u', test: false, replace: true }, h.exec)
    expect(updated.ok).toBe(true)
    expect(updated.action).toBe('replaced')

    const entries = readConnections(h.globalPath)
    expect(entries).toHaveLength(1)
    expect(entries[0]!['host']).toBe('h2')
    // No password supplied on update → the previously stored ciphertext survives.
    expect(String(entries[0]!['password'])).toMatch(/^enc:v1:/)
  })

  it('writes to the workspace file when scope=workspace, leaving the global file untouched', async () => {
    const h = harness()
    const result = await h.tool.execute({
      name: 'ws-only',
      scope: 'workspace',
      dialect: 'postgresql',
      host: '10.0.0.5',
      username: 'pg',
      password: 'pw-ws',
      defaultDatabase: 'appdb',
      test: false,
    }, h.exec)

    expect(result.ok).toBe(true)
    expect(result.scope).toBe('workspace')
    const wsFile = path.join(h.workspace, '.dsh', 'db-manager.json')
    expect(String(result.path)).toBe(wsFile)
    expect(readConnections(wsFile)).toHaveLength(1)
    expect(fs.existsSync(h.globalPath)).toBe(false)
  })

  it('supports sqlite (file path, no password)', async () => {
    const h = harness()
    const result = await h.tool.execute({ name: 'local', dialect: 'sqlite', file: './data/app.db', test: false }, h.exec)
    expect(result.ok).toBe(true)
    const entry = readConnections(h.globalPath)[0]!
    expect(entry['dialect']).toBe('sqlite')
    expect(entry['file']).toBe('./data/app.db')
    expect(entry['password']).toBeUndefined()
  })

  it('rejects incomplete server connections with an actionable message', async () => {
    const h = harness()
    const noHost = await h.tool.execute({ name: 'bad', dialect: 'mysql', username: 'u', password: 'p', test: false }, h.exec)
    expect(noHost.ok).toBe(false)
    expect(String(noHost.failureMessage)).toContain('host')

    const noUsername = await h.tool.execute({ name: 'bad2', dialect: 'mysql', host: 'h', password: 'p', test: false }, h.exec)
    expect(noUsername.ok).toBe(false)
    expect(String(noUsername.failureMessage)).toContain('username')

    const newWithoutPassword = await h.tool.execute({ name: 'nopw', dialect: 'mysql', host: 'h', username: 'u', test: false }, h.exec)
    expect(newWithoutPassword.ok).toBe(false)
    expect(String(newWithoutPassword.failureMessage)).toMatch(/密码/)
  })

  it('invalid fields are refused by schema validation (no file write)', async () => {
    const h = harness()
    const result = await h.tool.execute({ name: 'bad-port', dialect: 'mysql', host: 'h', port: 70000, username: 'u', password: 'p', test: false }, h.exec)
    expect(result.ok).toBe(false)
    expect(result.ok === false && typeof result.failureHint === 'string').toBe(true)
    expect(fs.existsSync(h.globalPath)).toBe(false)
  })

  it('runs a connectivity test by default and reports a classified failure', async () => {
    const h = harness()
    // 127.0.0.1:1 refuses immediately; connectTimeoutMs is 300ms in the harness.
    const result = await h.tool.execute({
      name: 'unreachable',
      dialect: 'mysql',
      host: '127.0.0.1',
      port: 1,
      username: 'u',
      password: 'p',
    }, h.exec)
    // The write still succeeded; the test outcome is reported separately.
    expect(result.ok).toBe(true)
    expect(result.testOk).toBe(false)
    expect(typeof result.testErrorKind).toBe('string')
  })

  it('writes an audit entry for success and for refusal', async () => {
    const h = harness()
    await h.tool.execute({ name: 'audited', dialect: 'mysql', host: 'h', username: 'u', password: 'p', test: false }, h.exec)
    await h.tool.execute({ name: 'audited', dialect: 'mysql', host: 'h', username: 'u', password: 'p', test: false }, h.exec)

    const entries = auditEntries(h.auditDir).filter((e) => e['action'] === 'db_add_connection')
    expect(entries.length >= 2).toBe(true)
    const okEntry = entries.find((e) => e['status'] === 'ok')
    const errEntry = entries.find((e) => e['status'] === 'error')
    expect(okEntry?.['connection']).toBe('audited')
    expect(String(okEntry?.['detail'])).toContain('created')
    expect(errEntry?.['connection']).toBe('audited')
    // Never leak the plaintext into the audit trail.
    expect(JSON.stringify(entries)).not.toContain('"password"')
  })
})

describe('config/mutate.ts — scope-aware writes', () => {
  it('preserves unrelated top-level fields in the workspace file', () => {
    const root = tmpDir('dbm-mutate-')
    const ws = path.join(root, 'ws')
    fs.mkdirSync(path.join(ws, '.dsh'), { recursive: true })
    const wsFile = path.join(ws, '.dsh', 'db-manager.json')
    fs.writeFileSync(wsFile, JSON.stringify({ connections: [], useGlobal: ['a'], default: 'a' }, null, 2), 'utf8')
    const store = new ConfigStore({ globalConfigPath: path.join(root, 'g.json') })

    const outcome = saveConnectionInto(store, { scope: 'workspace', cwd: ws }, {
      connection: { name: 'b', dialect: 'mysql', host: 'h', username: 'u', passwordMode: 'plain', passwordPlain: 'pw' },
    })
    expect(outcome.ok).toBe(true)
    const doc = JSON.parse(fs.readFileSync(wsFile, 'utf8')) as Record<string, unknown>
    expect(doc['useGlobal']).toEqual(['a'])
    expect(doc['default']).toBe('a')
    expect((doc['connections'] as unknown[]).length).toBe(1)
  })

  it('refuses workspace writes when the session has no cwd', () => {
    const root = tmpDir('dbm-mutate-')
    const store = new ConfigStore({ globalConfigPath: path.join(root, 'g.json') })
    const outcome = saveConnectionInto(store, { scope: 'workspace' }, {
      connection: { name: 'x', dialect: 'mysql', host: 'h', username: 'u', passwordMode: 'plain', passwordPlain: 'pw' },
    })
    expect(outcome.ok).toBe(false)
    expect(String(outcome.error)).toContain('工作区')
  })

  it('never overwrites a corrupt config file (audit M5)', () => {
    const root = tmpDir('dbm-mutate-')
    const globalPath = path.join(root, 'connections.json')
    fs.writeFileSync(globalPath, '{ "connections": [ { "name": "a" },', 'utf8')
    const store = new ConfigStore({ globalConfigPath: globalPath })
    const outcome = saveConnectionInto(store, { scope: 'global' }, {
      connection: { name: 'b', dialect: 'mysql', host: 'h', username: 'u', passwordMode: 'plain', passwordPlain: 'pw' },
    })
    expect(outcome.ok).toBe(false)
    expect(fs.readFileSync(globalPath, 'utf8')).toBe('{ "connections": [ { "name": "a" },')
  })
})
