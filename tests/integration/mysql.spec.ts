/**
 * Integration tests against a real MySQL server. Opt-in via environment:
 *
 *   DBM_TEST_URL=mysql://root:secret@127.0.0.1:3306 npm test
 *
 * (or set DBM_TEST_URL + DBM_TEST_PW separately). The suite creates a
 * throwaway database, exercises the full db_* tool surface through the real
 * safety gateway, and drops it afterwards. Everything skips when the URL is
 * absent, so plain `npm test` stays hermetic.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditLog } from '../../src/audit/log.js'
import { ConfigStore } from '../../src/config/store.js'
import { PoolManager } from '../../src/db/pool.js'
import { UsageTracker } from '../../src/usage.js'
import { buildTools, type ToolDeps } from '../../src/tools/index.js'

const url = process.env.DBM_TEST_URL
const describeIntegration = url === undefined || url.length === 0 ? describe.skip : describe

const parsed = url === undefined ? new URL('mysql://root@127.0.0.1:3306') : new URL(url)
const HOST = parsed.hostname
const PORT = Number.parseInt(parsed.port || '3306', 10)
const USER = decodeURIComponent(parsed.username)
const PASSWORD = decodeURIComponent(parsed.password)

let admin: mysql.Connection
let scratchDb = ''
let workspaceDir = ''
let globalDirPath = ''
let tools: Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>
let auditDir = ''

async function call(name: string, args: unknown = {}): Promise<Record<string, unknown>> {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`tool ${name} missing`)
  return (await tool.execute(args, {})) as Record<string, unknown>
}

beforeAll(async () => {
  admin = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASSWORD })
  scratchDb = `dbm_it_${Date.now().toString(36)}`
  await admin.query(`CREATE DATABASE \`${scratchDb}\``)
  process.env.DBM_TEST_PW = PASSWORD

  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-it-ws-'))
  globalDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-it-home-'))
  fs.mkdirSync(path.join(workspaceDir, '.dsh'), { recursive: true })
  fs.writeFileSync(
    path.join(workspaceDir, '.dsh', 'db-manager.json'),
    JSON.stringify({
      connections: [{ name: 'it', host: HOST, port: PORT, username: USER, password: '$ENV:DBM_TEST_PW', defaultDatabase: scratchDb, mode: 'readwrite' }],
    }),
  )
  const store = new ConfigStore({ globalConfigPath: path.join(globalDirPath, 'connections.json') })
  const auditDirPath = path.join(globalDirPath, 'audit')
  const deps: ToolDeps = { store, pools: new PoolManager(), audit: new AuditLog({ dir: auditDirPath, enabled: true }), usage: new UsageTracker({ file: path.join(globalDirPath, 'usage.json') }), connectTimeoutMs: 5000, queryTimeoutMs: 10000, maxRows: 200, backupEnabled: true, backupMaxRows: 100, backupDefault: 'small-only', backupSmallThreshold: 1000 }
  tools = new Map(buildTools(deps).map((tool) => [String((tool as { name: string }).name), tool as { execute: (args: unknown, exec: unknown) => Promise<unknown> }]))
  auditDir = auditDirPath
})

afterAll(async () => {
  try {
    if (admin !== undefined) await admin.query(`DROP DATABASE IF EXISTS \`${scratchDb}\``)
    await admin?.end()
  } catch {
    /* cleanup best-effort */
  }
  for (const dir of [workspaceDir, globalDirPath]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describeIntegration('db-manager integration (MySQL)', () => {
  it('resolves the workspace connection and passes the health test', async () => {
    const list = await call('db_list_connections')
    const connections = list['connections'] as Array<{ name: string; scope: string; isDefault: boolean }>
    expect(connections).toHaveLength(1)
    expect(connections[0]).toMatchObject({ name: 'it', scope: 'workspace', isDefault: true })

    const test = await call('db_test_connection')
    expect(test['ok']).toBe(true)
    expect(typeof test['latencyMs']).toBe('number')
  })

  it('lists databases and tables through the metadata tools', async () => {
    const dbs = await call('db_list_databases')
    expect(dbs['databases']).toContain(scratchDb)
    expect(dbs['databases']).toContain('information_schema')

    const tables = await call('db_list_tables')
    expect(tables['database']).toBe(scratchDb)
    expect(tables['tables']).toEqual([])
  })

  it('executes DDL, describes structure, and reports DDL text', async () => {
    const create = await call('db_execute', { sql: `CREATE TABLE items (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(64) NOT NULL, note VARCHAR(200) NULL)` })
    expect(create['ok']).toBe(true)
    expect(create['refused']).toBe(false)

    const desc = await call('db_describe_table', { table: 'items' })
    expect(desc['database']).toBe(scratchDb)
    const columns = desc['columns'] as Array<{ name: string; columnType: string }>
    expect(columns.map((c) => c.name)).toEqual(['id', 'name'])
    expect(desc['ddl']).toContain('CREATE TABLE')

    const tables = await call('db_list_tables')
    expect((tables['tables'] as Array<{ name: string }>).map((t) => t.name)).toContain('items')
  })

  it('runs read-only queries with automatic LIMIT and truncation', async () => {
    for (let i = 1; i <= 3; i += 1) {
      const insert = await call('db_execute', { sql: `INSERT INTO items (name) VALUES ('row-${i}')` })
      expect(insert['affectedRows']).toBe(1)
    }
    const query = await call('db_query', { sql: 'SELECT id, name FROM items ORDER BY id' })
    expect(query['rowCount']).toBe(3)
    expect(query['truncated']).toBe(false)

    const capped = await call('db_query', { sql: 'SELECT id FROM items', limit: 2 })
    expect(capped['rowCount']).toBe(2)
    expect(capped['truncated']).toBe(true)
    expect(capped['totalEstimate']).toBe(3)
  })

  it('rejects writes on the read-only channel with guidance', async () => {
    const refused = await call('db_query', { sql: 'DELETE FROM items' })
    expect(String(refused['failureMessage'])).toContain('拒绝')
  })

  it('refuses dangerous writes without a token and completes with one', async () => {
    const withoutWhere = await call('db_execute', { sql: 'DELETE FROM items' })
    expect(withoutWhere['refused']).toBe(true)
    expect(withoutWhere['reason']).toBe('dangerous')
    const token = withoutWhere['confirmToken']
    expect(typeof token).toBe('string')

    // A different statement must NOT be accepted with this token.
    const mismatch = await call('db_execute', { sql: 'DELETE FROM items', confirmToken: `9999999999999.${String(token).split('.')[1]}` })
    expect(mismatch['refused']).toBe(true)

    const confirmed = await call('db_execute', { sql: 'DELETE FROM items', confirmToken: token })
    expect(confirmed['ok']).toBe(true)

    const rows = await call('db_query', { sql: 'SELECT COUNT(*) AS c FROM items' })
    expect((rows['rows'] as Array<{ c: number }>)[0]?.['c']).toBe(0)
  })

  it('rejects writes on read-only connections outright', async () => {
    fs.writeFileSync(
      path.join(workspaceDir, '.dsh', 'db-manager.json'),
      JSON.stringify({
        connections: [
          { name: 'it-ro', host: HOST, port: PORT, username: USER, password: '$ENV:DBM_TEST_PW', defaultDatabase: scratchDb, mode: 'readonly' },
          { name: 'it', host: HOST, port: PORT, username: USER, password: '$ENV:DBM_TEST_PW', defaultDatabase: scratchDb, mode: 'readwrite' },
        ],
        default: 'it-ro',
      }),
    )
    try {
      const refused = await call('db_execute', { connection: 'it-ro', sql: 'INSERT INTO items (name) VALUES (\'x\')' })
      expect(refused['refused']).toBe(true)
      expect(refused['reason']).toBe('read-only-mode')
    } finally {
      fs.writeFileSync(
        path.join(workspaceDir, '.dsh', 'db-manager.json'),
        JSON.stringify({
          connections: [{ name: 'it', host: HOST, port: PORT, username: USER, password: '$ENV:DBM_TEST_PW', defaultDatabase: scratchDb, mode: 'readwrite' }],
        }),
      )
    }
  })

  it('shadow-backs up affected rows before UPDATE and DELETE', async () => {
    // items currently holds 3 rows; UPDATE touches 2 of them.
    const update = await call('db_execute', { sql: "UPDATE items SET name = CONCAT(name, '-upd') WHERE id <= 2" })
    expect(update['ok']).toBe(true)
    expect(update['backupRows']).toBe(2)
    const backupTable = update['backupTable'] as string
    expect(typeof backupTable).toBe('string')
    expect(backupTable.startsWith('__dbm_backup_items_')).toBe(true)
    const check = await call('db_query', { sql: `SELECT COUNT(*) AS c FROM \`${backupTable}\`` })
    expect((check['rows'] as Array<Record<string, unknown>>)[0]?.['c']).toBe(2)
    // restore the pre-update values from the backup to prove recovery works
    // (multi-table UPDATE → plugin backup is infeasible → backupAck acknowledges
    // the shadow backup we just verified manually)
    const restore = await call('db_execute', { sql: `UPDATE items JOIN \`${backupTable}\` b ON items.id = b.id SET items.name = b.name WHERE items.id = b.id`, backupAck: true })
    expect(restore['refused']).toBe(false)
    const names = await call('db_query', { sql: 'SELECT name FROM items WHERE id = 1' })
    expect((names['rows'] as Array<{ name: string }>)[0]?.['name']).toBe('row-1')
  })

  it('refuses oversized deletes with manual-backup guidance and proceeds on backupAck', async () => {
    const create = await call('db_execute', { sql: 'CREATE TABLE big_rows (id INT PRIMARY KEY AUTO_INCREMENT, v VARCHAR(8))' })
    expect(create['ok']).toBe(true)
    const values = Array.from({ length: 101 }, (_, i) => `('v${i}')`).join(',')
    const seed = await call('db_execute', { sql: 'INSERT INTO big_rows (v) VALUES ' + values })
    expect(seed['ok']).toBe(true)

    const refused = await call('db_execute', { sql: 'DELETE FROM big_rows' })
    expect(refused['refused']).toBe(true)
    expect(refused['reason']).toBe('backup-infeasible')
    expect(String(refused['riskExplanation'])).toContain('超过自动备份上限')
    expect(String(refused['riskExplanation'])).toContain('CREATE TABLE')

    // ack alone is not enough: a no-WHERE DELETE is still dangerous and needs a token
    const ackNoToken = await call('db_execute', { sql: 'DELETE FROM big_rows', backupAck: true })
    expect(ackNoToken['refused']).toBe(true)
    expect(ackNoToken['reason']).toBe('dangerous')
    const token = ackNoToken['confirmToken']
    expect(typeof token).toBe('string')

    const acknowledged = await call('db_execute', { sql: 'DELETE FROM big_rows', backupAck: true, confirmToken: token })
    expect(acknowledged['ok']).toBe(true)
    expect(acknowledged['backupSkipped']).toBe(true)
  })

  it('leaves an audit trail without credentials', async () => {
    const files = fs.readdirSync(auditDir).filter((f) => f.endsWith('.jsonl'))
    expect(files.length).toBeGreaterThan(0)
    const content = files.map((f) => fs.readFileSync(path.join(auditDir, f), 'utf8')).join('')
    expect(content).toContain('db_execute')
    expect(content).toContain('refused-dangerous')
    expect(content).not.toContain(PASSWORD)
    expect(content).not.toContain('DBM_TEST_PW')
  })
})
