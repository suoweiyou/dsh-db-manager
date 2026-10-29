/**
 * RPC table browser helpers (v0.13): settings-page read-only metadata
 * navigation — list tables in a connection's database, then describe one
 * (columns + indexes + best-effort DDL). Both helpers reuse the same
 * node:sqlite path the AI-side `db_list_tables` / `db_describe_table`
 * tools take, so the GUI behavior mirrors what models already see.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigStore } from '../src/config/store.js'
import { PoolManager } from '../src/db/pool.js'
import { browseTablesForRpc, describeTableForRpc, resolveSpecForRpc } from '../src/rpc/routes.js'

const RT = { connectTimeoutMs: 5_000, queryTimeoutMs: 5_000 }

describe('browseTablesForRpc / describeTableForRpc — v0.13 GUI table browser', () => {
  it('returns a config failure when the connection name is missing', async () => {
    const store = new ConfigStore({ globalConfigPath: path.join(os.tmpdir(), '__no_such_dbm__.json') })
    const pools = new PoolManager()
    const outcome = await browseTablesForRpc(store, { ...RT, pools }, '', undefined)
    expect(outcome.ok).toBe(false)
    expect(outcome.failure?.kind).toBe('config')
    expect(outcome.failure?.message).toContain('缺少 connection 参数')
  })

  it('returns a config failure when the connection does not exist', async () => {
    const store = new ConfigStore({ globalConfigPath: path.join(os.tmpdir(), '__no_such_dbm__.json') })
    const pools = new PoolManager()
    const outcome = await browseTablesForRpc(store, { ...RT, pools }, 'ghost', undefined)
    expect(outcome.ok).toBe(false)
    expect(outcome.failure?.kind).toBe('config')
    expect(outcome.failure?.message).toContain('连接 "ghost" 不存在')
  })

  it('returns a config failure when no database is resolvable', async () => {
    const tmp = makeStoreFile([{ name: 'empty-mysql', dialect: 'mysql', host: 'h', port: 3306, username: 'u', password: '$ENV:P', mode: 'readonly' }])
    const store = new ConfigStore({ globalConfigPath: tmp })
    const pools = new PoolManager()
    const outcome = await browseTablesForRpc(store, { ...RT, pools }, 'empty-mysql', undefined)
    expect(outcome.ok).toBe(false)
    expect(outcome.failure?.kind).toBe('config')
    expect(outcome.failure?.message).toContain('未指定 database')
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
  })

  it('lists tables + DDL via the SQLite driver for a `:memory:` connection', async () => {
    // The DSH sandbox blocks sqlite file IO, so we cannot seed a real file
    // in tests. We use `:memory:` and seed it through the pool's acquire so
    // the cache key (file = ':memory:' + fingerprint) matches the next
    // acquire and the browser reuses the same DatabaseSync — exactly the
    // production code path.
    const tmp = makeStoreFile([{ name: 'mem', dialect: 'sqlite', file: ':memory:', defaultDatabase: ':memory:', mode: 'readwrite' }])
    const store = new ConfigStore({ globalConfigPath: tmp })
    const pools = new PoolManager()

    const seedDriver = await pools.acquire(
      { name: 'mem', dialect: 'sqlite', file: ':memory:', mode: 'readwrite' },
      { connectTimeoutMs: RT.queryTimeoutMs, queryTimeoutMs: RT.queryTimeoutMs, allowedRoots: [] },
    )
    await seedDriver.query('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    await seedDriver.query('CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER)')

    const listOutcome = await browseTablesForRpc(store, { ...RT, pools }, 'mem', undefined)
    expect(listOutcome.ok).toBe(true)
    expect(listOutcome.connection).toBe('mem')
    expect(listOutcome.dialect).toBe('sqlite')
    expect(listOutcome.tables?.map((t) => t.name).sort()).toEqual(['orders', 'users'])

    const describeOutcome = await describeTableForRpc(store, { ...RT, pools }, 'mem', 'users', undefined)
    expect(describeOutcome.ok).toBe(true)
    expect(describeOutcome.table).toBe('users')
    const cols = describeOutcome.columns ?? []
    expect(cols.map((c) => c.name)).toEqual(['id', 'name'])
    expect(cols.find((c) => c.name === 'name')?.nullable).toBe('NO')
    expect(describeOutcome.ddl).toBeDefined()
    expect(describeOutcome.ddl).toContain('CREATE TABLE')

    fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
  })

  it('returns a config failure when describing a table that does not exist', async () => {
    const tmp = makeStoreFile([{ name: 'mem', dialect: 'sqlite', file: ':memory:', defaultDatabase: ':memory:', mode: 'readwrite' }])
    const store = new ConfigStore({ globalConfigPath: tmp })
    const pools = new PoolManager()
    // Seed nothing — the database exists but has no tables, so describe on
    // an arbitrary name must surface the "table does not exist" failure.
    const outcome = await describeTableForRpc(store, { ...RT, pools }, 'mem', 'no_such_table', undefined)
    expect(outcome.ok).toBe(false)
    expect(outcome.failure?.kind).toBe('config')
    expect(outcome.failure?.message).toContain('no_such_table')
    expect(outcome.failure?.message).toContain('不存在')
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
  })

  it('returns a config failure when the table parameter is empty', async () => {
    const tmp = makeStoreFile([{ name: 'mem', dialect: 'sqlite', file: ':memory:', mode: 'readwrite' }])
    const store = new ConfigStore({ globalConfigPath: tmp })
    const pools = new PoolManager()
    const outcome = await describeTableForRpc(store, { ...RT, pools }, 'mem', '', undefined)
    expect(outcome.ok).toBe(false)
    expect(outcome.failure?.kind).toBe('config')
    expect(outcome.failure?.message).toContain('缺少 table 参数')
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
  })
})

function makeStoreFile(connections: Array<Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-rpc-tables-'))
  const file = path.join(dir, 'connections.json')
  fs.writeFileSync(file, JSON.stringify({ connections }, null, 2), 'utf8')
  return file
}

/**
 * v0.18: the「项目」tab renders the same card as the global one, so its「查看表」
 * must resolve the connection from the PROJECT file. Before this, a project
 * connection was either reported missing or — worse, when a global connection
 * shared its name — silently resolved to the GLOBAL connection's tables.
 */
describe('resolveSpecForRpc — project connections are browsable', () => {
  function projectFixture(): { store: ConfigStore; ws: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-wsbrowse-'))
    const globalFile = path.join(dir, 'connections.json')
    fs.writeFileSync(globalFile, JSON.stringify({
      connections: [{ name: 'shared', dialect: 'mysql', host: 'GLOBAL-HOST', port: 3306, username: 'u', password: '$ENV:P', mode: 'readonly' }],
    }, null, 2), 'utf8')
    const ws = path.join(dir, 'proj')
    fs.mkdirSync(path.join(ws, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.dsh', 'db-manager.json'), JSON.stringify({
      connections: [
        { name: 'shared', dialect: 'mysql', host: 'PROJECT-HOST', port: 3307, username: 'u', password: '$ENV:P', mode: 'readonly' },
        { name: 'only-project', dialect: 'mysql', host: 'ONLY-PROJECT', port: 3308, username: 'u', password: '$ENV:P', mode: 'readonly' },
      ],
    }, null, 2), 'utf8')
    return { store: new ConfigStore({ globalConfigPath: globalFile }), ws, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
  }

  it('resolves a project-private connection that does not exist globally', async () => {
    const f = projectFixture()
    try {
      const resolved = resolveSpecForRpc(f.store, 'only-project', f.ws)
      expect(resolved.spec?.host).toBe('ONLY-PROJECT')
      // …and it is genuinely absent from the global view.
      expect(resolveSpecForRpc(f.store, 'only-project').spec).toBeUndefined()
    } finally {
      f.cleanup()
    }
  })

  it('lets the project definition win for a name that exists in both files', async () => {
    const f = projectFixture()
    try {
      expect(resolveSpecForRpc(f.store, 'shared', f.ws).spec?.host).toBe('PROJECT-HOST')
      // Without the project context the global definition is what gets browsed.
      expect(resolveSpecForRpc(f.store, 'shared').spec?.host).toBe('GLOBAL-HOST')
    } finally {
      f.cleanup()
    }
  })

  it('names the project in the failure when the connection is missing there', async () => {
    const f = projectFixture()
    try {
      const resolved = resolveSpecForRpc(f.store, 'ghost', f.ws)
      expect(resolved.spec).toBeUndefined()
      expect(resolved.failure?.kind).toBe('config')
      expect(String(resolved.failure?.message)).toContain(f.ws)
    } finally {
      f.cleanup()
    }
  })

  it('browse helpers accept the project context end to end', async () => {
    const f = projectFixture()
    try {
      const pools = new PoolManager()
      const outcome = await browseTablesForRpc(f.store, { ...RT, pools }, 'only-project', undefined, f.ws)
      // No server is reachable, but the failure must be about CONNECTING — a
      // resolution failure would say the connection does not exist.
      expect(outcome.ok).toBe(false)
      expect(String(outcome.failure?.message)).not.toContain('不存在')
    } finally {
      f.cleanup()
    }
  })
})