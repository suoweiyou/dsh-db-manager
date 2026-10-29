/**
 * Workspace (项目) tab plumbing (v0.15): the project list comes from what the
 * plugin has actually observed (usage tracking), workspace writes land in the
 * project's own `.dsh/db-manager.json`, and — critically — a workspace path
 * supplied by the page is only accepted when the tracker already knows it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteConnectionFrom, duplicateConnection, moveConnection, renameWithRetry, saveConnectionInto } from '../src/config/mutate.js'
import { ConfigStore, workspaceConfigPath } from '../src/config/store.js'
import { resolveKnownWorkspace } from '../src/rpc/routes.js'
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

function workspaceWith(root: string, name: string): string {
  const ws = path.join(root, name)
  fs.mkdirSync(path.join(ws, '.dsh'), { recursive: true })
  return ws
}

const MYSQL_PLAIN = { passwordMode: 'plain', passwordPlain: 'pw' }

describe('UsageTracker — workspace discovery (project list source)', () => {
  it('reports workspaces from recorded usage, most recent first', () => {
    const dir = tmpDir('dbm-ws-')
    let clock = 1_000
    const tracker = new UsageTracker({ file: path.join(dir, 'usage.json'), now: () => (clock += 1_000) })
    tracker.record('conn-a', 'session-1', 'D:/proj/one', 'db_query')
    tracker.record('conn-a', 'session-1', 'D:/proj/two', 'db_query')
    expect(tracker.workspacePaths()).toEqual(['D:/proj/two', 'D:/proj/one'])
    expect(tracker.knowsWorkspace('D:/proj/one')).toBe(true)
    expect(tracker.knowsWorkspace('D:/proj/three')).toBe(false)
  })

  it('also surfaces the cwd of a live session that has not been persisted yet', () => {
    const dir = tmpDir('dbm-ws-')
    const tracker = new UsageTracker({ file: path.join(dir, 'usage.json') })
    tracker.record('conn-b', 'session-9', 'E:/live/project', 'db_list_tables')
    expect(tracker.knowsWorkspace('E:/live/project')).toBe(true)
    expect(tracker.workspacePaths()).toContain('E:/live/project')
  })

  it('survives a restart (persisted workspaces are reloaded)', async () => {
    const dir = tmpDir('dbm-ws-')
    const file = path.join(dir, 'usage.json')
    const first = new UsageTracker({ file })
    first.record('conn-a', 'session-1', 'F:/persisted', 'db_query')
    await first.flush()

    const second = new UsageTracker({ file })
    expect(second.knowsWorkspace('F:/persisted')).toBe(true)
  })
})

describe('resolveKnownWorkspace — fail-closed path whitelist', () => {
  function tracker(): UsageTracker {
    const dir = tmpDir('dbm-wsguard-')
    const t = new UsageTracker({ file: path.join(dir, 'usage.json') })
    t.record('conn-a', 'session-1', 'D:/proj/known', 'db_query')
    return t
  }

  it('accepts a workspace the tracker has observed', () => {
    expect(resolveKnownWorkspace(tracker(), 'D:/proj/known')).toEqual({ path: 'D:/proj/known' })
  })

  it('refuses an arbitrary path (a token-holding page must not write anywhere)', () => {
    const outcome = resolveKnownWorkspace(tracker(), 'C:/Windows/System32')
    expect(outcome.path).toBeUndefined()
    expect(String(outcome.error)).toContain('未知工作区')
  })

  it('refuses an empty/missing path', () => {
    expect(resolveKnownWorkspace(tracker(), '').path).toBeUndefined()
    expect(resolveKnownWorkspace(tracker(), undefined).path).toBeUndefined()
    expect(resolveKnownWorkspace(tracker(), '   ').path).toBeUndefined()
  })

  it('refuses everything when usage tracking is unavailable', () => {
    const outcome = resolveKnownWorkspace(undefined, 'D:/proj/known')
    expect(outcome.path).toBeUndefined()
    expect(String(outcome.error)).toContain('不可用')
  })
})

describe('workspace-scoped config writes', () => {
  it('writes a project-private connection into <project>/.dsh/db-manager.json only', () => {
    const root = tmpDir('dbm-wswrite-')
    const ws = workspaceWith(root, 'proj')
    const store = new ConfigStore({ globalConfigPath: path.join(root, 'global', 'connections.json') })

    const outcome = saveConnectionInto(store, { scope: 'workspace', cwd: ws }, {
      connection: { name: 'local-dev', dialect: 'mysql', host: '127.0.0.1', username: 'u', ...MYSQL_PLAIN },
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.path).toBe(workspaceConfigPath(ws))
    expect(outcome.action).toBe('created')

    const saved = JSON.parse(fs.readFileSync(workspaceConfigPath(ws)!, 'utf8')) as { connections: Array<{ name: string; password: string }> }
    expect(saved.connections).toHaveLength(1)
    expect(saved.connections[0]!.name).toBe('local-dev')
    expect(saved.connections[0]!.password).toMatch(/^enc:v1:/)
    // The global file must not be created by a workspace-scoped write.
    expect(fs.existsSync(path.join(root, 'global', 'connections.json'))).toBe(false)
  })

  it('updates in place with replace semantics and keeps the stored secret', () => {
    const root = tmpDir('dbm-wswrite-')
    const ws = workspaceWith(root, 'proj')
    const store = new ConfigStore({ globalConfigPath: path.join(root, 'global', 'connections.json') })
    saveConnectionInto(store, { scope: 'workspace', cwd: ws }, {
      connection: { name: 'a', dialect: 'mysql', host: 'h1', username: 'u', ...MYSQL_PLAIN },
    })
    const updated = saveConnectionInto(store, { scope: 'workspace', cwd: ws }, {
      originalName: 'a',
      connection: { name: 'a', dialect: 'mysql', host: 'h2', username: 'u', passwordMode: 'keep' },
    })
    expect(updated.ok).toBe(true)
    expect(updated.action).toBe('replaced')
    const saved = JSON.parse(fs.readFileSync(workspaceConfigPath(ws)!, 'utf8')) as { connections: Array<{ host: string; password: string }> }
    expect(saved.connections).toHaveLength(1)
    expect(saved.connections[0]!.host).toBe('h2')
    expect(saved.connections[0]!.password).toMatch(/^enc:v1:/)
  })

  it('refuses a duplicate name inside the same project', () => {
    const root = tmpDir('dbm-wswrite-')
    const ws = workspaceWith(root, 'proj')
    const store = new ConfigStore({ globalConfigPath: path.join(root, 'global', 'connections.json') })
    saveConnectionInto(store, { scope: 'workspace', cwd: ws }, {
      connection: { name: 'dup', dialect: 'mysql', host: 'h', username: 'u', ...MYSQL_PLAIN },
    })
    const conflict = saveConnectionInto(store, { scope: 'workspace', cwd: ws }, {
      connection: { name: 'dup', dialect: 'mysql', host: 'h2', username: 'u', ...MYSQL_PLAIN },
    })
    expect(conflict.ok).toBe(false)
    expect(String(conflict.error)).toContain('已存在同名连接')
  })

  it('deletes one project connection and leaves the others intact', () => {
    const root = tmpDir('dbm-wswrite-')
    const ws = workspaceWith(root, 'proj')
    const store = new ConfigStore({ globalConfigPath: path.join(root, 'global', 'connections.json') })
    for (const name of ['keep', 'drop']) {
      saveConnectionInto(store, { scope: 'workspace', cwd: ws }, {
        connection: { name, dialect: 'mysql', host: 'h', username: 'u', ...MYSQL_PLAIN },
      })
    }
    const removed = deleteConnectionFrom(store, { scope: 'workspace', cwd: ws }, 'drop')
    expect(removed.ok).toBe(true)
    const saved = JSON.parse(fs.readFileSync(workspaceConfigPath(ws)!, 'utf8')) as { connections: Array<{ name: string }> }
    expect(saved.connections.map((c) => c.name)).toEqual(['keep'])
  })

  it('reports a missing project connection on delete', () => {
    const root = tmpDir('dbm-wswrite-')
    const ws = workspaceWith(root, 'proj')
    const store = new ConfigStore({ globalConfigPath: path.join(root, 'global', 'connections.json') })
    const outcome = deleteConnectionFrom(store, { scope: 'workspace', cwd: ws }, 'ghost')
    expect(outcome.ok).toBe(false)
    expect(String(outcome.error)).toContain('不存在')
  })

  it('preserves useGlobal / default when writing a project connection', () => {
    const root = tmpDir('dbm-wswrite-')
    const ws = workspaceWith(root, 'proj')
    const file = workspaceConfigPath(ws)!
    fs.writeFileSync(file, JSON.stringify({ connections: [], useGlobal: ['shared-a'], default: 'shared-a' }, null, 2), 'utf8')
    const store = new ConfigStore({ globalConfigPath: path.join(root, 'global', 'connections.json') })
    saveConnectionInto(store, { scope: 'workspace', cwd: ws }, {
      connection: { name: 'added', dialect: 'mysql', host: 'h', username: 'u', ...MYSQL_PLAIN },
    })
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(saved['useGlobal']).toEqual(['shared-a'])
    expect(saved['default']).toBe('shared-a')
    expect((saved['connections'] as unknown[]).length).toBe(1)
  })

  it('refuses workspace writes without a cwd, and refuses to overwrite a corrupt file', () => {
    const root = tmpDir('dbm-wswrite-')
    const store = new ConfigStore({ globalConfigPath: path.join(root, 'global', 'connections.json') })
    const noCwd = saveConnectionInto(store, { scope: 'workspace' }, {
      connection: { name: 'x', dialect: 'mysql', host: 'h', username: 'u', ...MYSQL_PLAIN },
    })
    expect(noCwd.ok).toBe(false)

    const ws = workspaceWith(root, 'broken')
    const file = workspaceConfigPath(ws)!
    fs.writeFileSync(file, '{ "connections": [', 'utf8')
    const corrupt = saveConnectionInto(store, { scope: 'workspace', cwd: ws }, {
      connection: { name: 'y', dialect: 'mysql', host: 'h', username: 'u', ...MYSQL_PLAIN },
    })
    expect(corrupt.ok).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "connections": [')
  })
})

/**
 * 「编辑时更改所属」(v0.20): moving a connection between the global file and a
 * project file, or between two projects. Cross-file, so the staging must fail
 * safely: everything is validated up front and the SOURCE is only touched after
 * the destination is written (a half-applied move may duplicate, never lose).
 */
describe('moveConnection — change a connection\'s owner', () => {
  function fixture(): { store: ConfigStore; globalFile: string; wsA: string; wsB: string; cleanup: () => void } {
    const root = tmpDir('dbm-move-')
    const globalFile = path.join(root, 'global', 'connections.json')
    fs.mkdirSync(path.dirname(globalFile), { recursive: true })
    fs.writeFileSync(globalFile, JSON.stringify({ connections: [] }, null, 2), 'utf8')
    const wsA = workspaceWith(root, 'proj-a')
    const wsB = workspaceWith(root, 'proj-b')
    return { store: new ConfigStore({ globalConfigPath: globalFile }), globalFile, wsA, wsB, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
  }

  function namesOf(file: string): string[] {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { connections?: Array<{ name: string }> }
    return (doc.connections ?? []).map((c) => c.name)
  }

  function rawOf(file: string): string {
    return fs.readFileSync(file, 'utf8')
  }

  it('moves a global connection into a project and keeps the stored secret', () => {
    const f = fixture()
    try {
      saveConnectionInto(f.store, { scope: 'global' }, {
        connection: { name: 'shared-db', dialect: 'mysql', host: 'h', username: 'u', ...MYSQL_PLAIN },
      })
      const secretBefore = (JSON.parse(rawOf(f.globalFile)) as { connections: Array<{ password: string }> }).connections[0]!.password

      const outcome = moveConnection(
        f.store,
        { scope: 'global' },
        { scope: 'workspace', cwd: f.wsA },
        {
          originalName: 'shared-db',
          connection: { name: 'shared-db', dialect: 'mysql', host: 'h2', username: 'u', passwordMode: 'keep' },
        },
      )
      expect(outcome.ok).toBe(true)
      expect(outcome.action).toBe('moved')
      expect(namesOf(f.globalFile)).toEqual([])
      const moved = JSON.parse(rawOf(workspaceConfigPath(f.wsA)!)) as { connections: Array<{ name: string; host: string; password: string }> }
      expect(moved.connections).toHaveLength(1)
      expect(moved.connections[0]!.name).toBe('shared-db')
      expect(moved.connections[0]!.host).toBe('h2')
      // The secret travelled verbatim — never decrypted, never re-encrypted.
      expect(moved.connections[0]!.password).toBe(secretBefore)
    } finally {
      f.cleanup()
    }
  })

  it('promotes a project connection to global', () => {
    const f = fixture()
    try {
      saveConnectionInto(f.store, { scope: 'workspace', cwd: f.wsA }, {
        connection: { name: 'proj-db', dialect: 'postgresql', host: 'p', username: 'u', ...MYSQL_PLAIN },
      })
      const outcome = moveConnection(
        f.store,
        { scope: 'workspace', cwd: f.wsA },
        { scope: 'global' },
        { originalName: 'proj-db', connection: { name: 'proj-db', dialect: 'postgresql', host: 'p', username: 'u', passwordMode: 'keep' } },
      )
      expect(outcome.ok).toBe(true)
      expect(namesOf(workspaceConfigPath(f.wsA)!)).toEqual([])
      expect(namesOf(f.globalFile)).toEqual(['proj-db'])
    } finally {
      f.cleanup()
    }
  })

  it('moves between two projects with a rename', () => {
    const f = fixture()
    try {
      saveConnectionInto(f.store, { scope: 'workspace', cwd: f.wsA }, {
        connection: { name: 'old-name', dialect: 'mysql', host: 'h', username: 'u', ...MYSQL_PLAIN },
      })
      const outcome = moveConnection(
        f.store,
        { scope: 'workspace', cwd: f.wsA },
        { scope: 'workspace', cwd: f.wsB },
        { originalName: 'old-name', connection: { name: 'new-name', dialect: 'mysql', host: 'h', username: 'u', passwordMode: 'keep' } },
      )
      expect(outcome.ok).toBe(true)
      expect(namesOf(workspaceConfigPath(f.wsA)!)).toEqual([])
      expect(namesOf(workspaceConfigPath(f.wsB)!)).toEqual(['new-name'])
    } finally {
      f.cleanup()
    }
  })

  it('refuses a target name conflict WITHOUT touching either file', () => {
    const f = fixture()
    try {
      saveConnectionInto(f.store, { scope: 'global' }, { connection: { name: 'dup', dialect: 'mysql', host: 'g', username: 'u', ...MYSQL_PLAIN } })
      saveConnectionInto(f.store, { scope: 'workspace', cwd: f.wsA }, { connection: { name: 'dup', dialect: 'mysql', host: 'w', username: 'u', ...MYSQL_PLAIN } })
      const globalBefore = rawOf(f.globalFile)
      const wsBefore = rawOf(workspaceConfigPath(f.wsA)!)

      const outcome = moveConnection(
        f.store,
        { scope: 'global' },
        { scope: 'workspace', cwd: f.wsA },
        { originalName: 'dup', connection: { name: 'dup', dialect: 'mysql', host: 'g', username: 'u', passwordMode: 'keep' } },
      )
      expect(outcome.ok).toBe(false)
      expect(String(outcome.error)).toContain('已存在同名连接')
      expect(rawOf(f.globalFile)).toBe(globalBefore)
      expect(rawOf(workspaceConfigPath(f.wsA)!)).toBe(wsBefore)
    } finally {
      f.cleanup()
    }
  })

  it('refuses when the source entry does not exist', () => {
    const f = fixture()
    try {
      const outcome = moveConnection(
        f.store,
        { scope: 'global' },
        { scope: 'workspace', cwd: f.wsA },
        { originalName: 'ghost', connection: { name: 'ghost', dialect: 'mysql', host: 'h', username: 'u', ...MYSQL_PLAIN } },
      )
      expect(outcome.ok).toBe(false)
      expect(String(outcome.error)).toContain('在源位置不存在')
    } finally {
      f.cleanup()
    }
  })

  it('refuses an invalid body without touching either file', () => {
    const f = fixture()
    try {
      saveConnectionInto(f.store, { scope: 'global' }, { connection: { name: 'keep-me', dialect: 'mysql', host: 'h', username: 'u', ...MYSQL_PLAIN } })
      const globalBefore = rawOf(f.globalFile)
      const outcome = moveConnection(
        f.store,
        { scope: 'global' },
        { scope: 'workspace', cwd: f.wsA },
        { originalName: 'keep-me', connection: { name: 'keep-me', dialect: 'mysql', username: 'u', passwordMode: 'keep' } }, // host missing
      )
      expect(outcome.ok).toBe(false)
      expect(rawOf(f.globalFile)).toBe(globalBefore)
      expect(fs.existsSync(workspaceConfigPath(f.wsA)!)).toBe(false)
    } finally {
      f.cleanup()
    }
  })

  it('behaves as an in-place update when source and destination are the same file', () => {
    const f = fixture()
    try {
      saveConnectionInto(f.store, { scope: 'global' }, { connection: { name: 'same', dialect: 'mysql', host: 'h1', username: 'u', ...MYSQL_PLAIN } })
      const outcome = moveConnection(
        f.store,
        { scope: 'global' },
        { scope: 'global' },
        { originalName: 'same', connection: { name: 'same', dialect: 'mysql', host: 'h2', username: 'u', passwordMode: 'keep' } },
      )
      expect(outcome.ok).toBe(true)
      expect(outcome.action).toBe('updated')
      expect(namesOf(f.globalFile)).toEqual(['same'])
      const doc = JSON.parse(rawOf(f.globalFile)) as { connections: Array<{ host: string }> }
      expect(doc.connections[0]!.host).toBe('h2')
    } finally {
      f.cleanup()
    }
  })

  it('reports a missing workspace cwd instead of guessing a path', () => {
    const f = fixture()
    try {
      const outcome = moveConnection(f.store, { scope: 'workspace' }, { scope: 'global' }, { originalName: 'x', connection: {} })
      expect(outcome.ok).toBe(false)
    expect(String(outcome.error)).toContain('无法确定')
    } finally {
      f.cleanup()
    }
  })
})

describe('renameWithRetry — transient Windows locks must not fail a save', () => {
  function failWith(code: string): NodeJS.ErrnoException {
    const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException
    error.code = code
    return error
  }

  it('retries EPERM/EBUSY/EACCES and succeeds', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      let calls = 0
      renameWithRetry('tmp', 'target', () => {
        calls += 1
        if (calls <= 2) throw failWith(code)
      })
      expect(calls).toBe(3)
    }
  })

  it('does not retry a non-transient failure', () => {
    let calls = 0
    let thrown: unknown
    try {
      renameWithRetry('tmp', 'target', () => {
        calls += 1
        throw failWith('ENOENT')
      })
    } catch (error) {
      thrown = error
    }
    expect(calls).toBe(1)
    expect((thrown as NodeJS.ErrnoException)?.code).toBe('ENOENT')
  })

  it('gives up after the attempt budget and rethrows the last error', () => {
    let calls = 0
    let thrown: unknown
    try {
      renameWithRetry('tmp', 'target', () => {
        calls += 1
        throw failWith('EPERM')
      }, 3)
    } catch (error) {
      thrown = error
    }
    expect(calls).toBe(3)
    expect((thrown as NodeJS.ErrnoException)?.code).toBe('EPERM')
  })

  it('performs the rename for real on the happy path', () => {
    const dir = tmpDir('dbm-rename-')
    const from = path.join(dir, 'a.json')
    const to = path.join(dir, 'b.json')
    fs.writeFileSync(from, '{"ok":true}', 'utf8')
    renameWithRetry(from, to)
    expect(fs.existsSync(from)).toBe(false)
    expect(fs.readFileSync(to, 'utf8')).toBe('{"ok":true}')
  })
})

/* ── v0.21: duplicating a connection (one server, several databases) ───────── */

describe('duplicateConnection — copy a connection and keep its secret', () => {
  function fixture(): { store: ConfigStore; globalFile: string; wsA: string; wsB: string } {
    const root = tmpDir('dbm-copy-')
    const globalFile = path.join(root, 'global', 'connections.json')
    fs.mkdirSync(path.dirname(globalFile), { recursive: true })
    fs.writeFileSync(globalFile, JSON.stringify({ connections: [] }, null, 2), 'utf8')
    return { store: new ConfigStore({ globalConfigPath: globalFile }), globalFile, wsA: workspaceWith(root, 'proj-a'), wsB: workspaceWith(root, 'proj-b') }
  }

  function entriesOf(file: string): Array<Record<string, unknown>> {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { connections?: Array<Record<string, unknown>> }
    return doc.connections ?? []
  }

  it('copies the stored secret byte-for-byte and defaults to a「-副本」name', () => {
    const f = fixture()
    saveConnectionInto(f.store, { scope: 'global' }, {
      connection: { name: 'app-dev', dialect: 'mysql', host: '10.0.0.9', port: 3306, username: 'app', defaultDatabase: 'app_dev', group: '10.0.0.9', passwordMode: 'plain', passwordPlain: 'pw' },
    })
    const source = entriesOf(f.globalFile)[0]!
    expect(String(source['password']).startsWith('enc:v1:')).toBe(true)

    const outcome = duplicateConnection(f.store, { scope: 'global' }, { scope: 'global' }, { originalName: 'app-dev' })
    expect(outcome.ok).toBe(true)
    expect(outcome.name).toBe('app-dev-副本')
    const copy = entriesOf(f.globalFile)[1]!
    // The page never sees the credential: it travels as the stored ciphertext.
    expect(copy['password']).toBe(source['password'])
    expect(copy['host']).toBe('10.0.0.9')
    expect(copy['defaultDatabase']).toBe('app_dev')
    expect(copy['group']).toBe('10.0.0.9')
    expect(copy['comment']).toBeUndefined()
  })

  it('auto-disambiguates the default name instead of refusing', () => {
    const f = fixture()
    const base = { name: 'app-dev', dialect: 'mysql', host: 'h', username: 'u', passwordMode: 'plain', passwordPlain: 'pw' }
    saveConnectionInto(f.store, { scope: 'global' }, { connection: base })
    expect(duplicateConnection(f.store, { scope: 'global' }, { scope: 'global' }, { originalName: 'app-dev' }).name).toBe('app-dev-副本')
    expect(duplicateConnection(f.store, { scope: 'global' }, { scope: 'global' }, { originalName: 'app-dev' }).name).toBe('app-dev-副本2')
    expect(duplicateConnection(f.store, { scope: 'global' }, { scope: 'global' }, { originalName: 'app-dev' }).name).toBe('app-dev-副本3')
  })

  it('refuses an explicit name that is taken, and writes nothing', () => {
    const f = fixture()
    const base = { name: 'app-dev', dialect: 'mysql', host: 'h', username: 'u', passwordMode: 'plain', passwordPlain: 'pw' }
    saveConnectionInto(f.store, { scope: 'global' }, { connection: base })
    saveConnectionInto(f.store, { scope: 'global' }, { connection: { ...base, name: 'app-test' } })
    const before = fs.readFileSync(f.globalFile, 'utf8')

    const outcome = duplicateConnection(f.store, { scope: 'global' }, { scope: 'global' }, { originalName: 'app-dev', name: 'app-test' })
    expect(outcome.ok).toBe(false)
    expect(String(outcome.error)).toContain('同名连接')
    expect(fs.readFileSync(f.globalFile, 'utf8')).toBe(before)
  })

  it('applies the database/group overrides and clears on null or empty', () => {
    const f = fixture()
    saveConnectionInto(f.store, { scope: 'global' }, {
      connection: { name: 'app-dev', dialect: 'mysql', host: 'h', username: 'u', defaultDatabase: 'app_dev', group: 'prod', passwordMode: 'plain', passwordPlain: 'pw' },
    })
    duplicateConnection(f.store, { scope: 'global' }, { scope: 'global' }, { originalName: 'app-dev', name: 'app-test', defaultDatabase: 'app_test', group: 'test' })
    duplicateConnection(f.store, { scope: 'global' }, { scope: 'global' }, { originalName: 'app-dev', name: 'app-bare', defaultDatabase: '', group: null })
    const byName = new Map(entriesOf(f.globalFile).map((entry) => [String(entry['name']), entry]))
    expect(byName.get('app-test')?.['defaultDatabase']).toBe('app_test')
    expect(byName.get('app-test')?.['group']).toBe('test')
    expect(byName.get('app-bare')?.['defaultDatabase']).toBeUndefined()
    expect(byName.get('app-bare')?.['group']).toBeUndefined()
  })

  it('copies across files (project → global) without touching the source', () => {
    const f = fixture()
    saveConnectionInto(f.store, { scope: 'workspace', cwd: f.wsA }, {
      connection: { name: 'proj-db', dialect: 'postgresql', host: 'pg', port: 5432, username: 'u', passwordMode: 'plain', passwordPlain: 'pw' },
    })
    const projectFile = path.join(f.wsA, '.dsh', 'db-manager.json')
    const secret = entriesOf(projectFile)[0]!['password']

    const outcome = duplicateConnection(f.store, { scope: 'workspace', cwd: f.wsA }, { scope: 'global' }, { originalName: 'proj-db', group: '迁移中' })
    expect(outcome.ok).toBe(true)
    expect(entriesOf(f.globalFile)).toHaveLength(1)
    expect(entriesOf(f.globalFile)[0]!['password']).toBe(secret)
    expect(entriesOf(f.globalFile)[0]!['group']).toBe('迁移中')
    // The source project file is untouched — a copy, not a move.
    expect(entriesOf(projectFile)).toHaveLength(1)
  })

  it('reports a missing source and refuses a source that fails validation', () => {
    const f = fixture()
    const missing = duplicateConnection(f.store, { scope: 'global' }, { scope: 'global' }, { originalName: 'nope' })
    expect(missing.ok).toBe(false)
    expect(String(missing.error)).toContain('不存在')

    // A hand-edited file can hold an entry the schema rejects: copying it must
    // fail loudly rather than propagate the malformed record.
    fs.writeFileSync(f.globalFile, JSON.stringify({ connections: [{ name: 'broken', dialect: 'mysql', mode: 'readonly', port: 'not-a-number' }] }), 'utf8')
    const broken = duplicateConnection(f.store, { scope: 'global' }, { scope: 'global' }, { originalName: 'broken' })
    expect(broken.ok).toBe(false)
    expect(entriesOf(f.globalFile)).toHaveLength(1)
  })
})
