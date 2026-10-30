/**
 * FR-22 — read-only SSH log sources (v0.22).
 *
 * Two layers:
 *   - the pure helpers that define the security-relevant behaviour: bounded tail
 *     windows, local keyword filtering and the FIXED journal command template
 *     (no caller text ever reaches a shell);
 *   - the config surface: schema validation of the whitelist, name resolution
 *     with workspace precedence, and the merge protection that keeps a GUI save
 *     from silently dropping `logSources`.
 *
 * The file-source transport (SFTP) is covered by the manual E2E recorded in
 * docs/CHANGELOG-v0.22-SSH只读日志.md; the journal transport gets an in-process
 * end-to-end test below, which also pins the exact command line sent to the
 * server.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
// ssh2 is CommonJS-only (same workaround as tests/ssh.spec.ts).
import ssh2Module from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_LOG_LINES, journalArgv, openLogSession, shapeLogResult, tailWindow, validateJournalSince } from '../src/db/ssh-log.js'
import { filterKeyword, clampLine } from '../src/db/ssh-log.js'
import { MAX_LOG_SOURCES_PER_PROFILE, sshProfileSchema } from '../src/config/schema.js'
import { ConfigStore } from '../src/config/store.js'
import { saveLogSourceInto, saveSshProfileInto } from '../src/config/mutate.js'
import { formatLogSources, parseLogSourcesText } from '../src/client/Section.js'
import { buildTools } from '../src/tools/index.js'
import { sshKeyTypeOf } from '../src/db/ssh-tunnel.js'
import type { SshProfileSpec } from '../src/shared/types.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function writeFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
}

describe('tailWindow — bounded tail read', () => {
  it('returns the LAST lines, not the first', () => {
    const buffer = Buffer.from('line1\nline2\nline3\nline4\n', 'utf8')
    const window = tailWindow(buffer, { maxLines: 2, maxBytes: 1000 })
    expect(window.lines).toEqual(['line3', 'line4'])
    expect(window.scannedLines).toBe(4)
    expect(window.truncated).toBe(true)
  })

  it('drops the partial leading line when the byte window starts mid-line', () => {
    const text = `aaaa\nbbbb\ncccc\n`
    // Keep only the last 6 bytes: "ccc\n" plus part of the previous line.
    const window = tailWindow(Buffer.from(text, 'utf8'), { maxLines: 100, maxBytes: 6 })
    expect(window.lines).toEqual(['cccc'])
    expect(window.truncated).toBe(true)
    expect(window.windowBytes).toBeLessThanOrEqual(6)
  })

  it('normalizes CRLF and ignores the trailing newline', () => {
    const window = tailWindow(Buffer.from('a\r\nb\r\n', 'utf8'), { maxLines: 10, maxBytes: 100 })
    expect(window.lines).toEqual(['a', 'b'])
    expect(window.truncated).toBe(false)
  })

  it('handles an empty file', () => {
    expect(tailWindow(Buffer.alloc(0), { maxLines: 10, maxBytes: 100 })).toEqual({
      lines: [],
      scannedLines: 0,
      truncated: false,
      windowBytes: 0,
    })
  })

  it('never returns more than maxLines even when bytes allow it', () => {
    const buffer = Buffer.from(Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n'), 'utf8')
    const window = tailWindow(buffer, { maxLines: 5, maxBytes: 10_000 })
    expect(window.lines).toHaveLength(5)
    expect(window.lines[4]).toBe('l49')
  })
})

describe('filterKeyword / clampLine', () => {
  it('matches case-insensitively and returns everything for an empty needle', () => {
    const lines = ['INFO started', 'ERROR boom', 'error again']
    expect(filterKeyword(lines, 'error')).toEqual(['ERROR boom', 'error again'])
    expect(filterKeyword(lines, '')).toEqual(lines)
    expect(filterKeyword(lines, '   ')).toEqual(lines)
  })

  it('clamps a pathological single line', () => {
    const clamped = clampLine('x'.repeat(5000))
    expect(clamped.length).toBeLessThan(2100)
    expect(clamped.endsWith('…（本行已截断）')).toBe(true)
  })
})

describe('journalArgv — fixed template, no caller text reaches a shell', () => {
  it('builds the documented command for a unit', () => {
    expect(journalArgv({ unit: 'app.service', lines: 100 })).toBe('journalctl --no-pager --output=short-iso -n 100 -u app.service')
  })

  it('adds a quoted --since for both accepted shapes', () => {
    expect(journalArgv({ unit: 'app.service', lines: 50, since: '-30min' })).toContain("--since '-30min'")
    expect(journalArgv({ unit: 'app.service', lines: 50, since: '2026-10-29 09:30:00' })).toContain("--since '2026-10-29 09:30:00'")
    expect(journalArgv({ unit: 'app.service', lines: 50, since: '2026-10-29' })).toContain("--since '2026-10-29'")
  })

  it('refuses a unit carrying shell metacharacters (defense in depth)', () => {
    expect(() => journalArgv({ unit: 'app.service; rm -rf /', lines: 10 })).toThrow(/单元名不合法/)
    expect(() => journalArgv({ unit: 'app$(whoami)', lines: 10 })).toThrow(/单元名不合法/)
  })

  it('refuses free-form --since text', () => {
    expect(validateJournalSince('-2h').ok).toBe(true)
    expect(validateJournalSince('-7d').ok).toBe(true)
    expect(validateJournalSince('yesterday').ok).toBe(false)
    expect(validateJournalSince("-1h'; rm -rf /").ok).toBe(false)
    expect(() => journalArgv({ unit: 'a.service', lines: 10, since: "-1h' evil" })).toThrow(/since/)
  })

  it('clamps the line count into the hard range', () => {
    expect(journalArgv({ unit: 'a.service', lines: 999_999 })).toContain(`-n ${MAX_LOG_LINES}`)
    expect(journalArgv({ unit: 'a.service', lines: 0 })).toContain('-n 1')
  })
})

describe('shapeLogResult — quota, keyword and truncation flags', () => {
  const source = { name: 'app', kind: 'file' as const, path: '/var/log/app.log' }

  it('filters by keyword inside the window and reports matched/scanned', () => {
    const buffer = Buffer.from('INFO a\nERROR b\nINFO c\nERROR d\n', 'utf8')
    const result = shapeLogResult({
      profile: 'jump',
      source,
      sample: { source, kind: 'file', target: '/var/log/app.log', buffer, windowBytes: buffer.length },
      lines: 100,
      keyword: 'error',
      maxBytes: 10_000,
      elapsedMs: 3,
    })
    expect(result.lines).toEqual(['ERROR b', 'ERROR d'])
    expect(result.matched).toBe(2)
    expect(result.scannedLines).toBe(4)
    expect(result.truncated).toBe(true) // filtered < window
    expect(result.maxBytes).toBe(10_000)
  })

  it('stays inside the byte quota', () => {
    const buffer = Buffer.from(Array.from({ length: 500 }, (_, i) => `line-${i}-${'x'.repeat(40)}`).join('\n'), 'utf8')
    const result = shapeLogResult({
      profile: 'jump',
      source,
      sample: { source, kind: 'file', target: '/var/log/app.log', buffer, windowBytes: buffer.length },
      lines: 500,
      maxBytes: 4000,
      elapsedMs: 1,
    })
    expect(Buffer.byteLength(result.lines.join('\n'), 'utf8')).toBeLessThanOrEqual(4000)
    expect(result.truncated).toBe(true)
  })
})

describe('log-source schema', () => {
  const base = { name: 'jump', host: '10.0.0.5', username: 'deploy', auth: { method: 'agent' as const } }

  it('accepts file and journal sources, with and without via', () => {
    const parsed = sshProfileSchema.safeParse({
      ...base,
      logSources: [
        { name: 'app', kind: 'file', path: '/var/log/app/app.log', label: '应用日志' },
        { name: 'app-journal', kind: 'journal', unit: 'app.service', via: 'db-host' },
      ],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a relative path or a ".." segment', () => {
    for (const bad of ['var/log/app.log', '/var/log/../../etc/shadow']) {
      const parsed = sshProfileSchema.safeParse({ ...base, logSources: [{ name: 'x', kind: 'file', path: bad }] })
      expect(parsed.success).toBe(false)
    }
  })

  it('rejects a journal source without a unit, and a unit with metacharacters', () => {
    expect(sshProfileSchema.safeParse({ ...base, logSources: [{ name: 'x', kind: 'journal' }] }).success).toBe(false)
    expect(sshProfileSchema.safeParse({ ...base, logSources: [{ name: 'x', kind: 'journal', unit: 'a;b' }] }).success).toBe(false)
    expect(sshProfileSchema.safeParse({ ...base, logSources: [{ name: 'x', kind: 'journal', unit: 'ssh@eth0.service' }] }).success).toBe(true)
  })

  it('rejects kind/target mismatches instead of ignoring the extra field', () => {
    expect(sshProfileSchema.safeParse({ ...base, logSources: [{ name: 'x', kind: 'file', path: '/a.log', unit: 'a.service' }] }).success).toBe(false)
    expect(sshProfileSchema.safeParse({ ...base, logSources: [{ name: 'x', kind: 'journal', unit: 'a.service', path: '/a.log' }] }).success).toBe(false)
  })

  it('rejects duplicate names and a self-referencing via', () => {
    const dup = sshProfileSchema.safeParse({
      ...base,
      logSources: [
        { name: 'app', kind: 'file', path: '/a.log' },
        { name: 'app', kind: 'file', path: '/b.log' },
      ],
    })
    expect(dup.success).toBe(false)
    if (!dup.success) expect(dup.error.issues[0]?.message).toContain('重复')

    const self = sshProfileSchema.safeParse({ ...base, logSources: [{ name: 'app', kind: 'file', path: '/a.log', via: 'jump' }] })
    expect(self.success).toBe(false)
  })

  it('caps the number of sources per profile', () => {
    const many = Array.from({ length: MAX_LOG_SOURCES_PER_PROFILE + 1 }, (_, i) => ({ name: `s${i}`, kind: 'file', path: `/var/log/${i}.log` }))
    expect(sshProfileSchema.safeParse({ ...base, logSources: many }).success).toBe(false)
  })
})

describe('ConfigStore.resolveLogSource — name lookup only', () => {
  function storeWith(globalProfiles: unknown[], workspaceProfiles?: unknown[]): { store: ConfigStore; cwd: string; globalFile: string } {
    const dir = tmpDir('dbm-logsrc-')
    const globalFile = path.join(dir, 'connections.json')
    writeFile(globalFile, { connections: [], sshProfiles: globalProfiles })
    const cwd = path.join(dir, 'ws')
    if (workspaceProfiles !== undefined) {
      writeFile(path.join(cwd, '.dsh', 'db-manager.json'), { connections: [], sshProfiles: workspaceProfiles })
    }
    return { store: new ConfigStore({ globalConfigPath: globalFile }), cwd, globalFile }
  }

  const profile = (name: string, sources: unknown[]): unknown => ({
    name,
    host: '10.0.0.5',
    username: 'deploy',
    auth: { method: 'agent' },
    logSources: sources,
  })

  it('resolves a source declared in the global file', () => {
    const { store, cwd } = storeWith([profile('jump', [{ name: 'app', kind: 'file', path: '/var/log/app.log' }])])
    const resolved = store.resolveLogSource(store.load(cwd), 'jump', 'app')
    expect(resolved.resolved?.source.path).toBe('/var/log/app.log')
    expect(resolved.resolved?.scope).toBe('global')
  })

  it('lists available names when the profile or source is unknown', () => {
    const { store, cwd } = storeWith([profile('jump', [{ name: 'app', kind: 'file', path: '/a.log' }])])
    const load = store.load(cwd)
    expect(store.resolveLogSource(load, 'nope', 'app').error).toContain('可用：jump')
    expect(store.resolveLogSource(load, 'jump', 'nope').error).toContain('可用：app')
  })

  it('explains an empty whitelist instead of a bare "not found"', () => {
    const { store, cwd } = storeWith([profile('jump', [])])
    const load = store.load(cwd)
    expect(store.resolveLogSource(load, 'jump', 'app').error).toContain('尚未登记任何日志源')
  })

  it('prefers the workspace profile over the global one', () => {
    const { store, cwd } = storeWith(
      [profile('jump', [{ name: 'app', kind: 'file', path: '/global.log' }])],
      [profile('jump', [{ name: 'app', kind: 'file', path: '/workspace.log' }])],
    )
    const resolved = store.resolveLogSource(store.load(cwd), 'jump', 'app')
    expect(resolved.resolved?.source.path).toBe('/workspace.log')
    expect(resolved.resolved?.scope).toBe('workspace')
  })
})

describe('saveSshProfileInto — merge protection for logSources', () => {
  function setup(): { store: ConfigStore; file: string; save: (body: Record<string, unknown>) => { ok: boolean; error?: string } } {
    const dir = tmpDir('dbm-logmerge-')
    const globalFile = path.join(dir, 'connections.json')
    const store = new ConfigStore({ globalConfigPath: globalFile })
    const save = (body: Record<string, unknown>) => saveSshProfileInto(store, { scope: 'global' }, body)
    save({
      profile: {
        name: 'jump',
        host: '10.0.0.5',
        username: 'deploy',
        auth: { method: 'password', password: { mode: 'plain', plain: 'hunter2' } },
        logSources: [{ name: 'app', kind: 'file', path: '/var/log/app.log' }],
      },
    })
    return { store, file: globalFile, save }
  }

  it('keeps the whitelist when a later save omits logSources (GUI edits a password)', () => {
    const { file, save } = setup()
    const outcome = save({
      originalName: 'jump',
      profile: {
        name: 'jump',
        host: '10.0.0.6',
        username: 'deploy',
        auth: { method: 'password', password: { mode: 'plain', plain: 'other' } },
      },
    })
    expect(outcome.ok).toBe(true)
    const stored = readJson(file).sshProfiles as Array<Record<string, unknown>>
    expect(stored[0]?.['host']).toBe('10.0.0.6')
    expect((stored[0]?.['logSources'] as unknown[]).length).toBe(1)
  })

  it('clears the whitelist when the caller sends an explicit empty array', () => {
    const { file, save } = setup()
    const outcome = save({
      originalName: 'jump',
      profile: {
        name: 'jump',
        host: '10.0.0.5',
        username: 'deploy',
        auth: { method: 'password', password: { mode: 'plain', plain: 'hunter2' } },
        logSources: [],
      },
    })
    expect(outcome.ok).toBe(true)
    const stored = readJson(file).sshProfiles as Array<Record<string, unknown>>
    expect(stored[0]?.['logSources']).toEqual([])
  })
})

describe('saveLogSourceInto — the in-conversation registration path', () => {
  function setup(): { store: ConfigStore; file: string; cwd: string } {
    const dir = tmpDir('dbm-logadd-')
    const globalFile = path.join(dir, 'connections.json')
    writeFile(globalFile, {
      connections: [],
      sshProfiles: [
        {
          name: 'jump',
          host: '10.0.0.5',
          username: 'deploy',
          auth: { method: 'password', password: 'enc:v1:abcdef' },
        },
      ],
    })
    return { store: new ConfigStore({ globalConfigPath: globalFile }), file: globalFile, cwd: path.join(dir, 'ws') }
  }

  it('creates, replaces and deletes a source, leaving credentials untouched', () => {
    const { store, file, cwd } = setup()
    const created = saveLogSourceInto(store, { scope: 'auto', cwd }, { profileName: 'jump', source: { name: 'app', kind: 'file', path: '/var/log/app.log' } })
    expect(created.ok).toBe(true)
    expect(created.action).toBe('created')
    expect(created.scope).toBe('global')

    const replaced = saveLogSourceInto(store, { scope: 'auto', cwd }, { profileName: 'jump', source: { name: 'app', kind: 'journal', unit: 'app.service' } })
    expect(replaced.action).toBe('replaced')

    let stored = readJson(file).sshProfiles as Array<Record<string, unknown>>
    expect(((stored[0]?.['logSources'] as Array<Record<string, unknown>>)[0])['unit']).toBe('app.service')
    expect(((stored[0]?.['auth'] as Record<string, unknown>)['password'])).toBe('enc:v1:abcdef')

    const deleted = saveLogSourceInto(store, { scope: 'auto', cwd }, { profileName: 'jump', source: { name: 'app', kind: 'file' }, delete: true })
    expect(deleted.action).toBe('deleted')
    stored = readJson(file).sshProfiles as Array<Record<string, unknown>>
    expect(stored[0]?.['logSources']).toEqual([])
  })

  it('refuses an invalid source instead of writing it', () => {
    const { store, file, cwd } = setup()
    const outcome = saveLogSourceInto(store, { scope: 'auto', cwd }, { profileName: 'jump', source: { name: 'bad', kind: 'journal', unit: 'a;rm -rf /' } })
    expect(outcome.ok).toBe(false)
    const stored = readJson(file).sshProfiles as Array<Record<string, unknown>>
    expect(stored[0]?.['logSources']).toBeUndefined()
  })

  it('reports unknown profiles with the available names', () => {
    const { store, cwd } = setup()
    const outcome = saveLogSourceInto(store, { scope: 'auto', cwd }, { profileName: 'nope', source: { name: 'app', kind: 'file', path: '/a.log' } })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('可用：jump')
  })

  it('refuses to delete a source that does not exist', () => {
    const { store, cwd } = setup()
    const outcome = saveLogSourceInto(store, { scope: 'auto', cwd }, { profileName: 'jump', source: { name: 'ghost', kind: 'file' }, delete: true })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('没有名为 "ghost"')
  })
})

describe('settings-page whitelist text (parse ↔ format)', () => {
  it('round-trips every field', () => {
    const text = [
      'app | file | /var/log/app/app.log | 应用日志',
      'app-journal | journal | app.service',
      'mysql-error | file | /var/log/mysql/error.log | 经 db-host-prod | via=db-host-prod',
    ].join('\n')
    const parsed = parseLogSourcesText(text)
    expect(parsed.errors).toEqual([])
    expect(parsed.sources).toEqual([
      { name: 'app', kind: 'file', path: '/var/log/app/app.log', label: '应用日志' },
      { name: 'app-journal', kind: 'journal', unit: 'app.service' },
      { name: 'mysql-error', kind: 'file', path: '/var/log/mysql/error.log', label: '经 db-host-prod', via: 'db-host-prod' },
    ])
    expect(formatLogSources(parsed.sources)).toBe(text)
  })

  it('ignores blank lines and comments', () => {
    const parsed = parseLogSourcesText('\n# 注释\napp | file | /a.log\n\n')
    expect(parsed.sources).toHaveLength(1)
    expect(parsed.errors).toEqual([])
  })

  it('reports the offending line number', () => {
    const parsed = parseLogSourcesText('app | file | /a.log\nb | socket | /b.log\nc | file | relative.log')
    expect(parsed.errors).toHaveLength(2)
    expect(parsed.errors[0]).toContain('第 2 行')
    expect(parsed.errors[1]).toContain('第 3 行')
    expect(parsed.sources).toHaveLength(1)
  })
})

describe('buildTools wiring — the four log tools are registered (and can be switched off)', () => {
  function deps(overrides: Record<string, unknown> = {}): never {
    const dir = tmpDir('dbm-logtools-')
    return {
      store: new ConfigStore({ globalConfigPath: path.join(dir, 'connections.json') }),
      pools: {} as never,
      audit: { record: () => undefined } as never,
      usage: {} as never,
      connectTimeoutMs: 5000,
      queryTimeoutMs: 15_000,
      maxRows: 200,
      backupEnabled: true,
      backupMaxRows: 100_000,
      backupDefault: 'small-only',
      backupSmallThreshold: 200,
      ...overrides,
    } as never
  }

  const names = (tools: unknown[]): string[] => tools.map((tool) => (tool as { name: string }).name)

  it('registers db_list_ssh_logs / db_read_ssh_log / db_search_ssh_logs / db_add_ssh_log_source', () => {
    const registered = names(buildTools(deps()))
    expect(registered).toContain('db_list_ssh_logs')
    expect(registered).toContain('db_read_ssh_log')
    expect(registered).toContain('db_search_ssh_logs')
    expect(registered).toContain('db_add_ssh_log_source')
  })

  it('omits them when logEnabled is false (emergency stop)', () => {
    const registered = names(buildTools(deps({ logEnabled: false })))
    expect(registered).not.toContain('db_read_ssh_log')
    expect(registered).not.toContain('db_search_ssh_logs')
    expect(registered).toContain('db_query')
  })
})

describe('openLogSession — journal end-to-end against an in-process SSH server', () => {
  const ssh2 = ssh2Module as unknown as {
    Server: new (config: { hostKeys: string[] }, listener: (client: SshServerClient) => void) => {
      listen(port: number, host: string, cb: () => void): void
      close(cb: () => void): void
      address(): { port: number }
    }
    utils: { parseKey(key: string): { getPublicSSH(): Buffer } | Error }
  }

  interface ExecInfo { command: string }
  interface SshServerClient {
    on(event: 'authentication', cb: (ctx: { method: string; accept(): void; reject(): void }) => void): void
    on(event: 'ready', cb: () => void): void
    on(event: 'session', cb: (accept: () => SshSession) => void): void
  }
  interface SshSession {
    on(event: 'exec', cb: (accept: () => SshChannel, reject: () => void, info: ExecInfo) => void): void
  }
  interface SshChannel {
    write(data: string): void
    exit(code: number): void
    end(): void
    stderr: { write(data: string): void }
  }

  interface JournalFixture {
    port: number
    knownHosts: string
    commands: string[]
    close: () => Promise<void>
  }

  /**
   * Minimal SSH server that only implements `exec` (no sftp subsystem) and
   * answers every command with two journal-style lines. Deliberately without
   * SFTP: that is the hardened-host case the lazy `openSftp` exists for.
   */
  async function startJournalServer(): Promise<JournalFixture> {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
    const dir = tmpDir('dbm-logjournal-')
    const commands: string[] = []

    const server = new ssh2.Server({ hostKeys: [privatePem] }, (client) => {
      client.on('authentication', (ctx) => ctx.accept())
      client.on('ready', () => undefined)
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _reject, info) => {
          commands.push(info.command)
          const stream = acceptExec()
          stream.write('2026-10-29T09:00:01+08:00 host app[1]: started\n')
          stream.write('2026-10-29T09:00:02+08:00 host app[1]: ERROR boom\n')
          stream.stderr.write('')
          stream.exit(0)
          stream.end()
        })
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port

    const parsedKey = ssh2.utils.parseKey(privatePem)
    if (parsedKey instanceof Error) throw parsedKey
    const blob = parsedKey.getPublicSSH()
    const knownHosts = path.join(dir, 'known_hosts')
    fs.writeFileSync(knownHosts, `[127.0.0.1]:${port} ${sshKeyTypeOf(blob)} ${blob.toString('base64')}\n`, 'utf8')
    return {
      port,
      knownHosts,
      commands,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  it('reads a journal source and sends exactly the fixed command template', async () => {
    const fixture = await startJournalServer()
    process.env.DBM_LOG_TEST_PW = 'pw'
    const profile: SshProfileSpec = {
      name: 'jump',
      host: '127.0.0.1',
      port: fixture.port,
      username: 'tester',
      auth: { method: 'password', password: '$ENV:DBM_LOG_TEST_PW' },
      knownHostsPath: fixture.knownHosts,
      readyTimeoutMs: 5000,
    }

    try {
      const session = await openLogSession({ profile })
      try {
        const sample = await session.read({ name: 'app-journal', kind: 'journal', unit: 'app.service' }, { lines: 100, maxBytes: 10_000, timeoutMs: 5000 })
        const text = sample.buffer.toString('utf8')
        expect(text).toContain('ERROR boom')
        expect(sample.target).toBe('journal:app.service')
        expect(fixture.commands).toEqual(['journalctl --no-pager --output=short-iso -n 100 -u app.service'])
      } finally {
        session.close()
      }
    } finally {
      delete process.env.DBM_LOG_TEST_PW
      await fixture.close()
    }
  })

  it('db_read_ssh_log returns the lines and audits them WITHOUT the log body', async () => {
    const fixture = await startJournalServer()
    process.env.DBM_LOG_TEST_PW = 'pw'
    const dir = tmpDir('dbm-logtool-')
    const globalFile = path.join(dir, 'connections.json')
    writeFile(globalFile, {
      connections: [],
      sshProfiles: [
        {
          name: 'jump',
          host: '127.0.0.1',
          port: fixture.port,
          username: 'tester',
          auth: { method: 'password', password: '$ENV:DBM_LOG_TEST_PW' },
          knownHostsPath: fixture.knownHosts,
          logSources: [{ name: 'app-journal', kind: 'journal', unit: 'app.service' }],
        },
      ],
    })
    const records: Array<Record<string, unknown>> = []
    const toolDeps = {
      store: new ConfigStore({ globalConfigPath: globalFile }),
      pools: {} as never,
      audit: { record: (entry: Record<string, unknown>) => records.push(entry) } as never,
      usage: {} as never,
      connectTimeoutMs: 5000,
      queryTimeoutMs: 15_000,
      maxRows: 200,
      backupEnabled: true,
      backupMaxRows: 100_000,
      backupDefault: 'small-only',
      backupSmallThreshold: 200,
    } as never

    try {
      const tool = (buildTools(toolDeps) as Array<{ name: string; execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> }>)
        .find((entry) => entry.name === 'db_read_ssh_log')
      expect(tool).toBeDefined()
      const result = await tool!.execute({ profile: 'jump', source: 'app-journal', lines: 50 }, {})
      expect(result['ok']).toBe(true)
      expect((result['lines'] as string[]).join('\n')).toContain('ERROR boom')
      expect(result['scannedLines']).toBe(2)
      // Audit records the window, never the content.
      expect(records.length).toBe(1)
      expect(JSON.stringify(records)).not.toContain('boom')

      const missing = await tool!.execute({ profile: 'jump', source: 'nope' }, {})
      expect(missing['ok']).toBe(false)
      expect(String(missing['failureHint'])).toContain('db_list_ssh_logs')
    } finally {
      delete process.env.DBM_LOG_TEST_PW
      await fixture.close()
    }
  })
})
