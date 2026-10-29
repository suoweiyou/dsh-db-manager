/**
 * SSH tunnel support (FR-13).
 *
 * The security-critical piece is host key verification: strict known_hosts
 * matching with no trust-on-first-use and no skip option. These tests exercise
 * that pure function directly (including hashed entries, non-default ports and
 * @revoked markers), plus config validation, secret handling and the pool's
 * tunnel-aware cache identity.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connect, createServer, type AddressInfo } from 'node:net'
import { generateKeyPairSync, createHmac, randomBytes } from 'node:crypto'
// ssh2 is CommonJS-only: named ESM imports fail at runtime, so take the default
// export and destructure (same workaround as node-sql-parser in safety/classify).
import ssh2Module from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteSshProfileFrom, saveSshProfileInto, resolveSecretField } from '../src/config/mutate.js'
import { sshProfileSchema } from '../src/config/schema.js'
import { ConfigStore } from '../src/config/store.js'
import { DEFAULT_HOST_KEY_ALGORITHMS, hostKeyAlgorithmPreference, knownHostCandidates, openSshTunnel, probeSshProfile, recordedHostKeyTypes, sshKeyTypeOf, verifyHostKeyAgainstKnownHosts } from '../src/db/ssh-tunnel.js'
import type { ConnectionSpec, SshProfileSpec } from '../src/shared/types.js'

const dirs: string[] = []

/** ssh2's CommonJS surface, destructured once. */
const ssh2 = ssh2Module as unknown as {
  Server: new (config: { hostKeys: string[] }, listener: (client: SshServerClient) => void) => {
    listen(port: number, host: string, cb: () => void): void
    close(cb: () => void): void
    address(): AddressInfo
  }
  utils: {
    parseKey(key: string): { getPublicSSH(): Buffer } | Error
    /** ssh2's own generator — produces keys its server/client can parse. */
    generateKeyPairSync(type: 'ed25519' | 'rsa'): { private: string; public: string }
  }
}

interface SshAuthContext {
  method: string
  password?: string
  accept(): void
  reject(): void
}

interface SshServerClient {
  on(event: 'authentication', cb: (ctx: SshAuthContext) => void): void
  on(event: 'ready', cb: () => void): void
  on(event: 'tcpip', cb: (accept: () => NodeJS.ReadWriteStream & { close(): void }, reject: () => void, info: { destIP: string; destPort: number }) => void): void
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Build an SSH wire-format public key blob + its known_hosts line. */
function makeHostKey(algo = 'ssh-ed25519'): { blob: Buffer; keyType: string; base64: string } {
  // The key material itself is irrelevant to the verifier; it compares the
  // whole wire blob. Random bytes keep two generated keys distinguishable.
  const keyBytes = randomBytes(32)
  const algoBuf = Buffer.from(algo, 'utf8')
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, algoBuf.length]), algoBuf,
    Buffer.from([0, 0, 0, keyBytes.length]), keyBytes,
  ])
  return { blob, keyType: algo, base64: blob.toString('base64') }
}

/**
 * The vitest shim does not implement `expect(promise).rejects`, so assertions
 * about async failures go through this helper.
 */
async function expectRejects(fn: () => Promise<unknown>, pattern: RegExp): Promise<string> {
  try {
    await fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!pattern.test(message)) throw new Error(`expected rejection matching ${pattern}, got: ${message}`)
    return message
  }
  throw new Error(`expected rejection matching ${pattern}, but the call resolved`)
}

function hashedPattern(host: string, salt = 'salted-value'): string {
  const saltBuf = Buffer.from(salt, 'utf8')
  const digest = createHmac('sha1', saltBuf).update(host, 'utf8').digest('base64').replace(/=+$/, '')
  return `|1|${saltBuf.toString('base64')}|${digest}`
}

describe('verifyHostKeyAgainstKnownHosts — strict, no TOFU', () => {
  it('accepts a key that is already recorded for the host', () => {
    const key = makeHostKey()
    const text = `10.0.0.5 ${key.keyType} ${key.base64}\n`
    const verdict = verifyHostKeyAgainstKnownHosts({ knownHostsText: text, host: '10.0.0.5', port: 22, keyBlob: key.blob })
    expect(verdict.ok).toBe(true)
  })

  it('refuses when the host presents a DIFFERENT key than the recorded one', () => {
    const recorded = makeHostKey()
    const presented = makeHostKey()
    const text = `10.0.0.5 ${recorded.keyType} ${recorded.base64}\n`
    const verdict = verifyHostKeyAgainstKnownHosts({ knownHostsText: text, host: '10.0.0.5', port: 22, keyBlob: presented.blob })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('不一致')
  })

  it('refuses an unknown host (never trusts on first use)', () => {
    const key = makeHostKey()
    const verdict = verifyHostKeyAgainstKnownHosts({ knownHostsText: '', host: '10.0.0.9', port: 22, keyBlob: key.blob })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('known_hosts 中没有')
  })

  it('requires the [host]:port form for non-default ports (OpenSSH semantics)', () => {
    const key = makeHostKey()
    const plain = `10.0.0.5 ${key.keyType} ${key.base64}\n`
    expect(verifyHostKeyAgainstKnownHosts({ knownHostsText: plain, host: '10.0.0.5', port: 2222, keyBlob: key.blob }).ok).toBe(false)
    const bracketed = `[10.0.0.5]:2222 ${key.keyType} ${key.base64}\n`
    expect(verifyHostKeyAgainstKnownHosts({ knownHostsText: bracketed, host: '10.0.0.5', port: 2222, keyBlob: key.blob }).ok).toBe(true)
    expect(knownHostCandidates('10.0.0.5', 22)).toEqual(['10.0.0.5'])
    expect(knownHostCandidates('10.0.0.5', 2222)).toEqual(['[10.0.0.5]:2222'])
  })

  it('accepts hashed |1|salt|hash entries', () => {
    const key = makeHostKey()
    const text = `${hashedPattern('10.0.0.5')} ${key.keyType} ${key.base64}\n`
    expect(verifyHostKeyAgainstKnownHosts({ knownHostsText: text, host: '10.0.0.5', port: 22, keyBlob: key.blob }).ok).toBe(true)
    // …and a different host must not match the same hashed line.
    expect(verifyHostKeyAgainstKnownHosts({ knownHostsText: text, host: '10.0.0.6', port: 22, keyBlob: key.blob }).ok).toBe(false)
  })

  it('honours @revoked', () => {
    const key = makeHostKey()
    const text = `@revoked 10.0.0.5 ${key.keyType} ${key.base64}\n`
    const verdict = verifyHostKeyAgainstKnownHosts({ knownHostsText: text, host: '10.0.0.5', port: 22, keyBlob: key.blob })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('@revoked')
  })

  it('matches one of several comma-separated host names and skips comments/blank lines', () => {
    const key = makeHostKey()
    const text = `# a comment\n\n10.0.0.4,10.0.0.5,alias ${key.keyType} ${key.base64}\r\n`
    expect(verifyHostKeyAgainstKnownHosts({ knownHostsText: text, host: '10.0.0.5', port: 22, keyBlob: key.blob }).ok).toBe(true)
  })

  it('refuses a malformed key blob instead of guessing', () => {
    const verdict = verifyHostKeyAgainstKnownHosts({ knownHostsText: '', host: 'h', port: 22, keyBlob: Buffer.from([0, 0]) })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain('无法识别')
  })

  it('reads the key type out of an SSH wire blob (and refuses other DER bytes)', () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const der = publicKey.export({ type: 'spki', format: 'der' })
    // SPKI DER is not SSH wire format — the verifier must not guess a type.
    expect(sshKeyTypeOf(der)).toBeUndefined()
    const key = makeHostKey('ecdsa-sha2-nistp256')
    expect(sshKeyTypeOf(key.blob)).toBe('ecdsa-sha2-nistp256')
    expect(sshKeyTypeOf(Buffer.alloc(0))).toBeUndefined()
  })

  it('distinguishes "known host, unrecorded key type" from "unknown host"', () => {
    // A server that publishes several key types (rsa + ecdsa + ed25519) while
    // known_hosts holds only the one the user once accepted: the presented type
    // varies with client preferences, so this must NOT be reported as "never
    // logged in" — that message sent the user looking for the wrong fix.
    const ecdsa = makeHostKey('ecdsa-sha2-nistp256')
    const ed25519 = makeHostKey('ssh-ed25519')
    const text = `[10.0.0.5]:2222 ${ecdsa.keyType} ${ecdsa.base64}\n`
    const mismatch = verifyHostKeyAgainstKnownHosts({ knownHostsText: text, host: '10.0.0.5', port: 2222, keyBlob: ed25519.blob })
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) {
      expect(mismatch.reason).toContain('只记录了')
      expect(mismatch.reason).toContain('ecdsa-sha2-nistp256')
      expect(mismatch.reason).toContain('ssh-ed25519')
      expect(mismatch.reason).toContain('ssh-keyscan -p 2222 10.0.0.5')
    }

    // Same type but a different key is a *different* (and more alarming) case.
    const otherEcdsa = makeHostKey('ecdsa-sha2-nistp256')
    const replaced = verifyHostKeyAgainstKnownHosts({ knownHostsText: text, host: '10.0.0.5', port: 2222, keyBlob: otherEcdsa.blob })
    expect(replaced.ok).toBe(false)
    if (!replaced.ok) expect(replaced.reason).toContain('不一致')

    // Truly unknown host keeps the "log in once" wording.
    const unknown = verifyHostKeyAgainstKnownHosts({ knownHostsText: text, host: '10.0.0.9', port: 2222, keyBlob: ecdsa.blob })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.reason).toContain('known_hosts 中没有')
  })
})

describe('host key algorithm preference — negotiate a type we already trust', () => {
  it('lists the recorded types for that host:port only', () => {
    const a = makeHostKey('ecdsa-sha2-nistp256')
    const b = makeHostKey('ssh-rsa')
    const text = [
      `10.0.0.5 ${a.keyType} ${a.base64}`,
      `[10.0.0.5]:2222 ${b.keyType} ${b.base64}`,
      `10.0.0.5 ${a.keyType} ${a.base64}`, // duplicate
      `10.0.0.6 ${a.keyType} ${a.base64}`, // other host
      '',
    ].join('\n')
    expect(recordedHostKeyTypes(text, '10.0.0.5', 22)).toEqual(['ecdsa-sha2-nistp256'])
    expect(recordedHostKeyTypes(text, '10.0.0.5', 2222)).toEqual(['ssh-rsa'])
    expect(recordedHostKeyTypes(text, '10.0.0.7', 22)).toEqual([])
  })

  it('puts recorded types first, then the standard list without duplicates', () => {
    const preference = hostKeyAlgorithmPreference(['ssh-rsa', 'ecdsa-sha2-nistp256'])
    expect(preference.slice(0, 2)).toEqual(['ssh-rsa', 'ecdsa-sha2-nistp256'])
    expect(new Set(preference).size).toBe(preference.length)
    // The fallback list must survive so a rotated type still gets a clear
    // verification error instead of an opaque "no matching algorithm".
    for (const fallback of DEFAULT_HOST_KEY_ALGORITHMS) expect(preference).toContain(fallback)
    // ssh2's own default puts ed25519 first; a recorded type must outrank it.
    expect(preference.indexOf('ssh-rsa')).toBeLessThan(preference.indexOf('ssh-ed25519'))
  })

  it('falls back to the standard order when nothing is recorded', () => {
    expect(hostKeyAlgorithmPreference([])).toEqual([...DEFAULT_HOST_KEY_ALGORITHMS])
  })
})

describe('sshProfileSchema — validation', () => {
  it('accepts a keyfile profile', () => {
    const parsed = sshProfileSchema.safeParse({
      name: 'jump', host: '10.0.0.5', username: 'deploy', auth: { method: 'keyfile', keyPath: '~/.ssh/id_rsa' },
    })
    expect(parsed.success).toBe(true)
  })

  it('requires keyPath for keyfile / privateKey for key / password for password', () => {
    expect(sshProfileSchema.safeParse({ name: 'a', host: 'h', username: 'u', auth: { method: 'keyfile' } }).success).toBe(false)
    expect(sshProfileSchema.safeParse({ name: 'a', host: 'h', username: 'u', auth: { method: 'key' } }).success).toBe(false)
    expect(sshProfileSchema.safeParse({ name: 'a', host: 'h', username: 'u', auth: { method: 'password' } }).success).toBe(false)
  })

  it('refuses plaintext secrets (only $ENV: or enc:v1:)', () => {
    const plain = sshProfileSchema.safeParse({ name: 'a', host: 'h', username: 'u', auth: { method: 'password', password: 'hunter2' } })
    expect(plain.success).toBe(false)
    const env = sshProfileSchema.safeParse({ name: 'a', host: 'h', username: 'u', auth: { method: 'password', password: '$ENV:SSH_PW' } })
    expect(env.success).toBe(true)
    const enc = sshProfileSchema.safeParse({ name: 'a', host: 'h', username: 'u', auth: { method: 'password', password: 'enc:v1:aa:bb:cc' } })
    expect(enc.success).toBe(true)
  })

  it('agent needs no secret material', () => {
    expect(sshProfileSchema.safeParse({ name: 'a', host: 'h', username: 'u', auth: { method: 'agent' } }).success).toBe(true)
  })
})

describe('resolveSecretField — same policy as database passwords', () => {
  it('keeps the existing secret when nothing is supplied', () => {
    expect(resolveSecretField(undefined, 'enc:v1:x:y:z', 'p')).toEqual({ value: 'enc:v1:x:y:z' })
    expect(resolveSecretField({ mode: 'keep' }, '$ENV:SSH_PW', 'p')).toEqual({ value: '$ENV:SSH_PW' })
  })

  it('errors when asked to keep a secret that does not exist', () => {
    expect(resolveSecretField({ mode: 'keep' }, undefined, 'SSH 密码').value).toBeUndefined()
  })

  it('turns plaintext into ciphertext and validates env/cipher input', () => {
    const plain = resolveSecretField({ mode: 'plain', plain: 'hunter2' }, undefined, 'p')
    expect(String(plain.value).startsWith('enc:v1:')).toBe(true)
    expect(resolveSecretField({ mode: 'env', env: 'SSH_PW' }, undefined, 'p')).toEqual({ value: '$ENV:SSH_PW' })
    expect(resolveSecretField({ mode: 'env', env: 'bad name' }, undefined, 'p').error).toContain('不合法')
    expect(resolveSecretField({ mode: 'enc', enc: 'not-a-cipher' }, undefined, 'p').error).toContain('enc:v1')
    expect(resolveSecretField({ mode: 'none' }, 'enc:v1:x:y:z', 'p')).toEqual({})
  })
})

describe('saveSshProfileInto / deleteSshProfileFrom', () => {
  function store(): { store: ConfigStore; file: string } {
    const dir = tmpDir('dbm-ssh-')
    const file = path.join(dir, 'connections.json')
    return { store: new ConfigStore({ globalConfigPath: file }), file }
  }

  function read(file: string): { sshProfiles?: Array<Record<string, unknown>> } {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as { sshProfiles?: Array<Record<string, unknown>> }
  }

  it('creates a profile and encrypts a plaintext password', () => {
    const { store: s, file } = store()
    const outcome = saveSshProfileInto(s, { scope: 'global' }, {
      profile: { name: 'jump', host: '10.0.0.5', port: 22, username: 'deploy', auth: { method: 'password', password: { mode: 'plain', plain: 'hunter2' } } },
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.action).toBe('created')
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain('hunter2')
    const auth = read(file).sshProfiles?.[0]?.['auth'] as Record<string, unknown>
    expect(String(auth['password']).startsWith('enc:v1:')).toBe(true)
  })

  it('refuses a duplicate name, and replaces when originalName is given', () => {
    const { store: s, file } = store()
    const body = { profile: { name: 'jump', host: 'h1', username: 'u', auth: { method: 'agent' } } }
    expect(saveSshProfileInto(s, { scope: 'global' }, body).ok).toBe(true)
    const conflict = saveSshProfileInto(s, { scope: 'global' }, { profile: { name: 'jump', host: 'h2', username: 'u', auth: { method: 'agent' } } })
    expect(conflict.ok).toBe(false)
    expect(String(conflict.error)).toContain('已存在同名 SSH 配置')
    const replaced = saveSshProfileInto(s, { scope: 'global' }, { originalName: 'jump', profile: { name: 'jump', host: 'h2', username: 'u', auth: { method: 'agent' } } })
    expect(replaced.action).toBe('replaced')
    expect(read(file).sshProfiles).toHaveLength(1)
    expect((read(file).sshProfiles?.[0] as Record<string, unknown>)['host']).toBe('h2')
  })

  it('keeps the stored secret on update and drops secrets of another method', () => {
    const { store: s, file } = store()
    saveSshProfileInto(s, { scope: 'global' }, {
      profile: { name: 'jump', host: 'h', username: 'u', auth: { method: 'password', password: { mode: 'plain', plain: 'pw1' } } },
    })
    const first = (read(file).sshProfiles?.[0]?.['auth'] as Record<string, unknown>)['password']
    // Update without touching the password, switching to agent auth.
    saveSshProfileInto(s, { scope: 'global' }, {
      originalName: 'jump',
      profile: { name: 'jump', host: 'h', username: 'u', auth: { method: 'agent' } },
    })
    const auth = read(file).sshProfiles?.[0]?.['auth'] as Record<string, unknown>
    expect(auth['method']).toBe('agent')
    // Switching method clears the now-irrelevant secret.
    expect(auth['password']).toBeUndefined()
    expect(first).toBeDefined()
  })

  it('preserves unrelated top-level fields and refuses corrupt files (M5)', () => {
    const { store: s, file } = store()
    fs.writeFileSync(file, JSON.stringify({ connections: [], sshProfiles: [], custom: 1 }, null, 2), 'utf8')
    saveSshProfileInto(s, { scope: 'global' }, { profile: { name: 'jump', host: 'h', username: 'u', auth: { method: 'agent' } } })
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(doc['custom']).toBe(1)

    fs.writeFileSync(file, '{ "sshProfiles": [', 'utf8')
    const refused = saveSshProfileInto(s, { scope: 'global' }, { profile: { name: 'x', host: 'h', username: 'u', auth: { method: 'agent' } } })
    expect(refused.ok).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "sshProfiles": [')
  })

  it('deletes a profile and reports a missing one', () => {
    const { store: s, file } = store()
    saveSshProfileInto(s, { scope: 'global' }, { profile: { name: 'jump', host: 'h', username: 'u', auth: { method: 'agent' } } })
    expect(deleteSshProfileFrom(s, { scope: 'global' }, 'jump').ok).toBe(true)
    expect(read(file).sshProfiles).toHaveLength(0)
    expect(deleteSshProfileFrom(s, { scope: 'global' }, 'jump').ok).toBe(false)
  })

  it('validates the profile shape before writing', () => {
    const { store: s, file } = store()
    const outcome = saveSshProfileInto(s, { scope: 'global' }, {
      profile: { name: 'jump', host: 'h', username: 'u', auth: { method: 'keyfile' } },
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.warnings?.join('；')).toContain('keyPath')
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('ConfigStore.resolveSshProfile', () => {
  function writeGlobal(dir: string, profiles: unknown[]): ConfigStore {
    const file = path.join(dir, 'connections.json')
    fs.writeFileSync(file, JSON.stringify({ connections: [], sshProfiles: profiles }, null, 2), 'utf8')
    return new ConfigStore({ globalConfigPath: file })
  }

  const spec: ConnectionSpec = { name: 'db1', dialect: 'mysql', host: '10.0.0.5', port: 3306, username: 'u', password: '$ENV:P', mode: 'readonly', sshProfile: 'jump' }

  it('finds a global profile', () => {
    const dir = tmpDir('dbm-sshres-')
    const s = writeGlobal(dir, [{ name: 'jump', host: '10.0.0.1', username: 'u', auth: { method: 'agent' } }])
    const resolved = s.resolveSshProfile(s.load(), spec)
    expect(resolved.profile?.host).toBe('10.0.0.1')
  })

  it('lets a workspace profile shadow the global one of the same name', () => {
    const dir = tmpDir('dbm-sshres-')
    const s = writeGlobal(dir, [{ name: 'jump', host: 'global-host', username: 'u', auth: { method: 'agent' } }])
    const ws = path.join(dir, 'proj')
    fs.mkdirSync(path.join(ws, '.dsh'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.dsh', 'db-manager.json'), JSON.stringify({ connections: [], sshProfiles: [{ name: 'jump', host: 'ws-host', username: 'u', auth: { method: 'agent' } }] }), 'utf8')
    const resolved = s.resolveSshProfile(s.load(ws), spec)
    expect(resolved.profile?.host).toBe('ws-host')
  })

  it('reports a missing profile with the available names', () => {
    const dir = tmpDir('dbm-sshres-')
    const s = writeGlobal(dir, [{ name: 'other', host: 'h', username: 'u', auth: { method: 'agent' } }])
    const resolved = s.resolveSshProfile(s.load(), spec)
    expect(resolved.profile).toBeUndefined()
    expect(String(resolved.error)).toContain('jump')
    expect(String(resolved.error)).toContain('other')
  })

  it('does nothing for a connection without sshProfile', () => {
    const dir = tmpDir('dbm-sshres-')
    const s = writeGlobal(dir, [])
    expect(s.resolveSshProfile(s.load(), { ...spec, sshProfile: undefined })).toEqual({})
  })
})

describe('openSshTunnel — end-to-end against an in-process SSH server', () => {
  interface Fixture {
    sshPort: number
    echoPort: number
    knownHosts: string
    hostKeyLine: string
    close: () => Promise<void>
  }

  /**
   * A tiny SSH server that honours direct-tcpip to a local echo server.
   * Pass `expectedPassword` to enforce one specific password (so a wrong
   * credential is distinguishable from a healthy handshake).
   */
  async function startFixture(expectedPassword?: string): Promise<Fixture> {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    // ssh2 parses PKCS#1 / OpenSSH PEM; PKCS#8 is not accepted by its parser.
    const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
    const dir = tmpDir('dbm-sshe2e-')

    // Echo server: whatever is written comes back.
    const echo = createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    const echoPort = (echo.address() as AddressInfo).port

    // SSH server accepting any auth (or one specific password) and forwarding
    // direct-tcpip to 127.0.0.1.
    const server = new ssh2.Server({ hostKeys: [privatePem] }, (client) => {
      client.on('authentication', (ctx: { method: string; password?: string; accept(): void; reject(): void }) => {
        if (expectedPassword === undefined) {
          ctx.accept()
        } else if (ctx.method === 'password' && ctx.password === expectedPassword) {
          ctx.accept()
        } else {
          ctx.reject()
        }
      })
      client.on('ready', () => undefined)
      client.on('tcpip', (accept, _reject, info) => {
        const stream = accept()
        const target = connect(info.destPort, info.destIP)
        target.on('connect', () => { stream.pipe(target).pipe(stream) })
        target.on('error', () => stream.close())
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const sshPort = (server.address() as AddressInfo).port

    // known_hosts entry for the server key: take the SSH wire blob from the
    // parsed PRIVATE key (ssh2 cannot parse an SPKI "PUBLIC KEY" PEM, but a
    // ParsedKey holds both halves).
    const parsedKey = ssh2.utils.parseKey(privatePem)
    if (parsedKey instanceof Error) throw parsedKey
    const blob = parsedKey.getPublicSSH()
    const keyType = sshKeyTypeOf(blob)
    const knownHosts = path.join(dir, 'known_hosts')
    const hostKeyLine = `[127.0.0.1]:${sshPort} ${keyType} ${blob.toString('base64')}`

    return {
      sshPort,
      echoPort,
      knownHosts,
      hostKeyLine,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await new Promise<void>((resolve) => echo.close(() => resolve()))
      },
    }
  }

  function profile(sshPort: number, knownHostsPath: string): SshProfileSpec {
    return {
      name: 'e2e',
      host: '127.0.0.1',
      port: sshPort,
      username: 'tester',
      auth: { method: 'password', password: '$ENV:DBM_SSH_TEST_PW' },
      knownHostsPath,
      readyTimeoutMs: 5000,
    }
  }

  it('forwards bytes to the target and closes cleanly', async () => {
    const fixture = await startFixture()
    process.env.DBM_SSH_TEST_PW = 'pw'
    fs.writeFileSync(fixture.knownHosts, `${fixture.hostKeyLine}\n`, 'utf8')
    try {
      const tunnel = await openSshTunnel({
        profile: profile(fixture.sshPort, fixture.knownHosts),
        targetHost: '127.0.0.1',
        targetPort: fixture.echoPort,
      })
      expect(tunnel.localPort).toBeGreaterThan(0)
      expect(tunnel.targetEndpoint).toBe(`127.0.0.1:${fixture.echoPort}`)
      // The forwarder must be loopback-only.
      const received = await new Promise<string>((resolve, reject) => {
        const socket = connect(tunnel.localPort, '127.0.0.1')
        socket.on('connect', () => socket.write('ping-through-tunnel'))
        socket.on('data', (data: Buffer) => { socket.end(); resolve(data.toString('utf8')) })
        socket.on('error', reject)
      })
      expect(received).toBe('ping-through-tunnel')
      await tunnel.close()
      // Closing twice must be safe (pool teardown can race).
      await tunnel.close()
    } finally {
      delete process.env.DBM_SSH_TEST_PW
      await fixture.close()
    }
  })

  it('refuses the connection when the server key is not in known_hosts', async () => {
    const fixture = await startFixture()
    process.env.DBM_SSH_TEST_PW = 'pw'
    fs.writeFileSync(fixture.knownHosts, '', 'utf8')
    try {
      await expectRejects(() => openSshTunnel({
        profile: profile(fixture.sshPort, fixture.knownHosts),
        targetHost: '127.0.0.1',
        targetPort: fixture.echoPort,
      }), /known_hosts 中没有|严格校验/)
    } finally {
      delete process.env.DBM_SSH_TEST_PW
      await fixture.close()
    }
  })

  it('refuses when the server presents a key that differs from the recorded one', async () => {
    const fixture = await startFixture()
    process.env.DBM_SSH_TEST_PW = 'pw'
    // Record a bogus (but well-formed) key for the same host.
    const other = makeHostKey()
    fs.writeFileSync(fixture.knownHosts, `[127.0.0.1]:${fixture.sshPort} ssh-rsa ${other.base64}\n`, 'utf8')
    try {
      await expectRejects(() => openSshTunnel({
        profile: profile(fixture.sshPort, fixture.knownHosts),
        targetHost: '127.0.0.1',
        targetPort: fixture.echoPort,
      }), /不一致|known_hosts/)
    } finally {
      delete process.env.DBM_SSH_TEST_PW
      await fixture.close()
    }
  })

  it('reports a missing known_hosts file as a configuration failure', async () => {
    const dir = tmpDir('dbm-sshe2e-')
    await expectRejects(() => openSshTunnel({
      profile: profile(2222, path.join(dir, 'nope')),
      targetHost: '127.0.0.1',
      targetPort: 1,
    }), /无法读取 known_hosts/)
  })

  /**
   * The real-world failure this guards: a jump host publishes several key types
   * (rsa + ecdsa + ed25519) while known_hosts only holds the one the user once
   * accepted. ssh2's own preference puts ed25519 first, so it would negotiate an
   * unrecorded type and the strict check would refuse with a message that read
   * like "you never logged in". The shipped code prefers a recorded type.
   */
  it('negotiates a key type known_hosts already records (multi-key server)', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const rsaPem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
    const ed25519 = ssh2.utils.generateKeyPairSync('ed25519')
    const dir = tmpDir('dbm-sshmulti-')

    const echo = createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    const echoPort = (echo.address() as AddressInfo).port

    // ed25519 first: that is what a default client would negotiate.
    const server = new ssh2.Server({ hostKeys: [ed25519.private, rsaPem] }, (client) => {
      client.on('authentication', (ctx: SshAuthContext) => ctx.accept())
      client.on('tcpip', (accept, _reject, info: { destIP: string; destPort: number }) => {
        const stream = accept()
        const target = connect(info.destPort, info.destIP)
        target.on('connect', () => { stream.pipe(target).pipe(stream) })
        target.on('error', () => stream.close())
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const sshPort = (server.address() as AddressInfo).port

    const parsedRsa = ssh2.utils.parseKey(rsaPem)
    if (parsedRsa instanceof Error) throw parsedRsa
    const knownHosts = path.join(dir, 'known_hosts')
    // ONLY the ssh-rsa key is recorded — ed25519 is deliberately absent.
    fs.writeFileSync(knownHosts, `[127.0.0.1]:${sshPort} ssh-rsa ${parsedRsa.getPublicSSH().toString('base64')}\n`, 'utf8')

    process.env.DBM_SSH_TEST_PW = 'pw'
    try {
      const tunnel = await openSshTunnel({
        profile: profile(sshPort, knownHosts),
        targetHost: '127.0.0.1',
        targetPort: echoPort,
      })
      expect(tunnel.localPort > 0).toBe(true)

      // Prove bytes really flow over that negotiated path.
      const echoed = await new Promise<string>((resolve, reject) => {
        const socket = connect(tunnel.localPort, '127.0.0.1')
        socket.on('connect', () => socket.write('multi-key-ok'))
        socket.on('data', (data: Buffer) => { socket.end(); resolve(data.toString('utf8')) })
        socket.on('error', reject)
      })
      expect(echoed).toBe('multi-key-ok')
      await tunnel.close()
    } finally {
      delete process.env.DBM_SSH_TEST_PW
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await new Promise<void>((resolve) => echo.close(() => resolve()))
    }
  })

  /* ── probeSshProfile: the「测试连接」button (no port forwarding) ────────── */

  it('probe: succeeds with the correct password', async () => {
    const fixture = await startFixture('right-pw')
    process.env.DBM_SSH_TEST_PW = 'right-pw'
    fs.writeFileSync(fixture.knownHosts, `${fixture.hostKeyLine}\n`, 'utf8')
    try {
      const result = await probeSshProfile(profile(fixture.sshPort, fixture.knownHosts))
      expect(result.endpoint).toContain('127.0.0.1')
      expect(result.latencyMs >= 0).toBe(true)
    } finally {
      delete process.env.DBM_SSH_TEST_PW
      await fixture.close()
    }
  })

  it('probe: reports an authentication failure for a wrong password', async () => {
    const fixture = await startFixture('right-pw')
    process.env.DBM_SSH_TEST_PW = 'wrong-pw'
    fs.writeFileSync(fixture.knownHosts, `${fixture.hostKeyLine}\n`, 'utf8')
    try {
      await expectRejects(
        () => probeSshProfile(profile(fixture.sshPort, fixture.knownHosts)),
        /认证失败|authentication/i,
      )
    } finally {
      delete process.env.DBM_SSH_TEST_PW
      await fixture.close()
    }
  })

  it('probe: still enforces the strict host key check', async () => {
    const fixture = await startFixture('right-pw')
    process.env.DBM_SSH_TEST_PW = 'right-pw'
    fs.writeFileSync(fixture.knownHosts, '', 'utf8')
    try {
      await expectRejects(
        () => probeSshProfile(profile(fixture.sshPort, fixture.knownHosts)),
        /known_hosts 中没有|严格校验/,
      )
    } finally {
      delete process.env.DBM_SSH_TEST_PW
      await fixture.close()
    }
  })
})
