import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connectionSchema, globalConfigSchema } from '../src/config/schema.js'
import { ConfigStore } from '../src/config/store.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dbm-${randomBytes(4).toString('hex')}-`))
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeDir(): string {
  const dir = tmpDir()
  dirs.push(dir)
  return dir
}

const ENV_PASSWORD = { password: '$ENV:MYSQL_PW' }

describe('connection schema', () => {
  it('applies defaults (port 3306, dialect mysql, readonly mode)', () => {
    const parsed = connectionSchema.parse({ name: 'a', host: 'h', username: 'u', ...ENV_PASSWORD })
    expect(parsed.port).toBe(3306)
    expect(parsed.dialect).toBe('mysql')
    expect(parsed.mode).toBe('readonly')
  })

  it('accepts postgresql dialect and lets the caller pick a non-default port', () => {
    const parsed = connectionSchema.parse({ name: 'pg1', host: 'h', port: 5432, username: 'u', dialect: 'postgresql', ...ENV_PASSWORD })
    expect(parsed.dialect).toBe('postgresql')
    expect(parsed.port).toBe(5432)
  })

  it('rejects unknown dialect values', () => {
    const result = connectionSchema.safeParse({ name: 'a', host: 'h', username: 'u', dialect: 'oracle', ...ENV_PASSWORD })
    expect(result.success).toBe(false)
  })

  it('accepts a SQLite connection that only specifies file', () => {
    const parsed = connectionSchema.parse({ name: 'local-db', dialect: 'sqlite', file: '/data/app.db' })
    expect(parsed.dialect).toBe('sqlite')
    if (parsed.dialect === 'sqlite') {
      expect(parsed.file).toBe('/data/app.db')
      expect(parsed.port).toBeUndefined()
    } else {
      throw new Error('expected sqlite branch')
    }
  })

  it('rejects a SQLite connection that omits file', () => {
    const result = connectionSchema.safeParse({ name: 'no-file', dialect: 'sqlite' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.some((i) => i.message.includes('file'))).toBe(true)
  })

  it('rejects a SQLite connection that still carries host/port/user/password', () => {
    const result = connectionSchema.safeParse({ name: 'sqlite-extra', dialect: 'sqlite', file: '/data/app.db', host: '127.0.0.1', port: 1234, username: 'u', password: '$ENV:FOO' })
    expect(result.success).toBe(false)
  })

  it('rejects plaintext passwords', () => {
    const result = connectionSchema.safeParse({ name: 'a', host: 'h', username: 'u', password: 'plain-secret' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.message).toContain('不允许明文')
  })

  it('rejects unknown keys (strict)', () => {
    const result = connectionSchema.safeParse({ name: 'a', host: 'h', username: 'u', ...ENV_PASSWORD, hostt: 'typo' })
    expect(result.success).toBe(false)
  })

  it('global schema validates an empty file', () => {
    expect(globalConfigSchema.parse({}).connections).toEqual([])
  })

  it('rejects forbidden driver overrides in extraParams (audit M6)', () => {
    for (const banned of [{ multipleStatements: 'true' }, { ssl: 'true' }, { host: 'evil.example' }, { localInfile: '1' }]) {
      const result = connectionSchema.safeParse({ name: 'a', host: 'h', username: 'u', ...ENV_PASSWORD, extraParams: banned })
      expect(result.success, JSON.stringify(banned)).toBe(false)
      if (!result.success) expect(result.error.issues[0]?.message).toContain('禁止覆盖')
    }
  })

  it('rejects URI entry points in extraParams (audit N1: mysql2 merges URI query flags)', () => {
    for (const banned of [
      { uri: 'mysql://evil:evil@evil/db?multipleStatements=true&localInfile=true' },
      { URI: 'mysql://evil/db?ssl={"rejectUnauthorized":false}' },
      { connectionString: 'mysql://evil/db' },
      { ConnectionString: 'mysql://evil/db' },
    ]) {
      const result = connectionSchema.safeParse({ name: 'a', host: 'h', username: 'u', ...ENV_PASSWORD, extraParams: banned })
      expect(result.success, JSON.stringify(banned)).toBe(false)
      if (!result.success) expect(result.error.issues[0]?.message).toContain('禁止覆盖')
    }
  })

  it('accepts harmless tuning options in extraParams', () => {
    const parsed = connectionSchema.parse({ name: 'a', host: 'h', username: 'u', ...ENV_PASSWORD, extraParams: { timezone: '+08:00', charset: 'utf8mb4' } })
    expect(parsed.extraParams).toEqual({ timezone: '+08:00', charset: 'utf8mb4' })
  })
})

describe('ConfigStore merge rules', () => {
  it('workspace same-name overrides global and marks scope', () => {
    const dir = makeDir()
    const globalPath = path.join(dir, 'connections.json')
    fs.writeFileSync(globalPath, JSON.stringify({
      connections: [
        { name: 'shared', host: 'global-host', username: 'gu', ...ENV_PASSWORD },
        { name: 'only-global', host: 'g2', username: 'u2', ...ENV_PASSWORD },
      ],
    }))
    const cwd = makeDir()
    fs.mkdirSync(path.join(cwd, '.dsh'))
    fs.writeFileSync(path.join(cwd, '.dsh', 'db-manager.json'), JSON.stringify({
      connections: [{ name: 'shared', host: 'ws-host', username: 'wu', ...ENV_PASSWORD }],
      default: 'shared',
    }))
    const store = new ConfigStore({ globalConfigPath: globalPath })
    const resolved = store.resolveConnections(store.load(cwd))
    const shared = resolved.connections.find((c) => c.name === 'shared')
    expect(shared?.host).toBe('ws-host')
    expect(shared?.scope).toBe('workspace')
    expect(shared?.isDefault).toBe(true)
    expect(resolved.defaultName).toBe('shared')
    expect(resolved.connections.find((c) => c.name === 'only-global')?.scope).toBe('global')
  })

  it('auto-defaults when exactly one connection is visible', () => {
    const dir = makeDir()
    const globalPath = path.join(dir, 'connections.json')
    fs.writeFileSync(globalPath, JSON.stringify({ connections: [{ name: 'solo', host: 'h', username: 'u', ...ENV_PASSWORD }] }))
    const store = new ConfigStore({ globalConfigPath: globalPath })
    const resolved = store.resolveConnections(store.load())
    expect(resolved.defaultName).toBe('solo')
  })

  it('warns visibly when a workspace connection shadows a same-name global (audit M4)', () => {
    const dir = makeDir()
    const globalPath = path.join(dir, 'connections.json')
    fs.writeFileSync(globalPath, JSON.stringify({
      connections: [{ name: 'shared', host: 'global-host', username: 'gu', ...ENV_PASSWORD }],
    }))
    const cwd = makeDir()
    fs.mkdirSync(path.join(cwd, '.dsh'))
    fs.writeFileSync(path.join(cwd, '.dsh', 'db-manager.json'), JSON.stringify({
      connections: [{ name: 'shared', host: 'ws-host', username: 'wu', ...ENV_PASSWORD }],
    }))
    const store = new ConfigStore({ globalConfigPath: globalPath })
    const resolved = store.resolveConnections(store.load(cwd))
    expect(resolved.connections.find((c) => c.name === 'shared')?.host).toBe('ws-host')
    const warning = resolved.warnings.find((w) => w.includes('覆盖'))
    expect(warning).toBeDefined()
    expect(warning).toContain('shared')
    expect(warning).toContain(path.join(cwd, '.dsh', 'db-manager.json'))
  })

  it('restricts visible global connections to a non-empty useGlobal whitelist (audit N9 / FR-2)', () => {
    const dir = makeDir()
    const globalPath = path.join(dir, 'connections.json')
    fs.writeFileSync(globalPath, JSON.stringify({
      connections: [
        { name: 'want-me', host: 'h1', username: 'u1', ...ENV_PASSWORD },
        { name: 'hide-me', host: 'h2', username: 'u2', ...ENV_PASSWORD },
      ],
    }))
    const cwd = makeDir()
    fs.mkdirSync(path.join(cwd, '.dsh'))
    fs.writeFileSync(path.join(cwd, '.dsh', 'db-manager.json'), JSON.stringify({
      connections: [],
      useGlobal: ['want-me'],
    }))
    const store = new ConfigStore({ globalConfigPath: globalPath })
    const resolved = store.resolveConnections(store.load(cwd))
    expect(resolved.connections.map((c) => c.name)).toEqual(['want-me'])
  })

  it('keeps every global connection visible when useGlobal is empty or absent (backward compatible)', () => {
    const dir = makeDir()
    const globalPath = path.join(dir, 'connections.json')
    fs.writeFileSync(globalPath, JSON.stringify({
      connections: [
        { name: 'a', host: 'h', username: 'u', ...ENV_PASSWORD },
        { name: 'b', host: 'h', username: 'u', ...ENV_PASSWORD },
      ],
    }))
    const store = new ConfigStore({ globalConfigPath: globalPath })
    expect(store.resolveConnections(store.load()).connections).toHaveLength(2)

    const cwd = makeDir()
    fs.mkdirSync(path.join(cwd, '.dsh'))
    fs.writeFileSync(path.join(cwd, '.dsh', 'db-manager.json'), JSON.stringify({ connections: [], useGlobal: [] }))
    const resolved = store.resolveConnections(store.load(cwd))
    expect(resolved.connections.map((c) => c.name).sort()).toEqual(['a', 'b'])
  })

  it('skips invalid entries with per-entry warnings and keeps valid ones', () => {
    const dir = makeDir()
    const globalPath = path.join(dir, 'connections.json')
    fs.writeFileSync(globalPath, JSON.stringify({
      connections: [
        { name: 'good', host: 'h', username: 'u', ...ENV_PASSWORD },
        { name: 'bad', host: 'h', username: 'u', password: 'definitely-plaintext' },
      ],
    }))
    const store = new ConfigStore({ globalConfigPath: globalPath })
    const load = store.load()
    expect(load.global.data?.connections).toHaveLength(1)
    expect(load.global.warnings.join('\n')).toContain('bad')
    expect(load.global.warnings.join('\n')).toContain('不允许明文')
  })

  it('returns an empty set with no warnings for a missing file', () => {
    const dir = makeDir()
    const store = new ConfigStore({ globalConfigPath: path.join(dir, 'missing.json') })
    const load = store.load()
    expect(load.global.exists).toBe(false)
    expect(load.global.warnings).toEqual([])
    expect(store.resolveConnections(load).connections).toEqual([])
  })
})
