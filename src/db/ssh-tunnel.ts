/**
 * SSH tunnel support (FR-13): reach a database that is only accessible from a
 * jump host by opening a local TCP forward through SSH.
 *
 * Why in-process (ssh2) instead of shelling out to the system `ssh`:
 *   - the tunnel lifecycle must be tied to a pool entry (open → used → closed
 *     with the driver), which is natural for an in-process client and awkward
 *     for a child process;
 *   - password / inline-key auth cannot be driven through the `ssh` binary;
 *   - no temp key files, no shell argument handling, no OS-version variance.
 *
 * Host key verification is STRICT: the presented key must already exist in the
 * configured known_hosts file (OpenSSH-compatible matching, including hashed
 * `|1|salt|hash` entries and `[host]:port` entries for non-default ports).
 * There is deliberately no "trust on first use" and no "skip verification".
 *
 * Security properties:
 *   - the local forwarder always binds 127.0.0.1 (never 0.0.0.0);
 *   - every socket is torn down with the tunnel; `close()` is idempotent;
 *   - secrets are resolved by the caller (see secrets.ts) and never logged.
 */
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import { Client, type ConnectConfig, type ServerHostKeyAlgorithm } from 'ssh2'
import { resolvePassword } from '../secrets.js'
import type { SshAuthSpec, SshProfileSpec } from '../shared/types.js'

export const DEFAULT_SSH_PORT = 22
export const DEFAULT_KNOWN_HOSTS = path.join(os.homedir(), '.ssh', 'known_hosts')

/**
 * Failure shapes the callers translate into DbErrorKind. Deliberately limited
 * to kinds the plugin already exposes (`DbErrorKind`), so an SSH failure flows
 * through `toDbFailure` unchanged: a host-key mismatch is a configuration
 * problem, not a new error class.
 */
export type SshFailureKind = 'config' | 'auth' | 'network' | 'timeout'

export class SshError extends Error {
  readonly kind: SshFailureKind
  readonly hint?: string
  constructor(kind: SshFailureKind, message: string, hint?: string) {
    super(message)
    this.name = 'SshError'
    this.kind = kind
    if (hint !== undefined) this.hint = hint
  }
}

/* ── known_hosts verification (pure helpers, unit-tested) ─────────────────── */

/** The algorithm name is the first length-prefixed string of an SSH key blob. */
export function sshKeyTypeOf(blob: Buffer): string | undefined {
  if (blob.length < 4) return undefined
  const length = blob.readUInt32BE(0)
  if (length === 0 || 4 + length > blob.length) return undefined
  return blob.subarray(4, 4 + length).toString('utf8')
}

/** base64 of the SSH wire-format key — exactly what known_hosts stores. */
export function sshKeyBase64(blob: Buffer): string {
  return blob.toString('base64')
}

interface KnownHostLine {
  markers: string[]
  patterns: string[]
  keyType: string
  keyBase64: string
}

function parseKnownHosts(text: string): KnownHostLine[] {
  const lines: KnownHostLine[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    let index = 0
    const markers: string[] = []
    while (parts[index]?.startsWith('@') === true) {
      markers.push(parts[index]!.slice(1))
      index += 1
    }
    const hostField = parts[index]
    const keyType = parts[index + 1]
    const keyBase64 = parts[index + 2]
    if (hostField === undefined || keyType === undefined || keyBase64 === undefined) continue
    lines.push({ markers, patterns: hostField.split(','), keyType, keyBase64 })
  }
  return lines
}

/** `|1|salt|hash` entries hash the hostname with HMAC-SHA1. */
function matchesHashedPattern(pattern: string, hostname: string): boolean {
  const parts = pattern.split('|')
  if (parts.length !== 4 || parts[1] !== '1') return false
  try {
    const salt = Buffer.from(parts[2]!, 'base64')
    const expected = parts[3]!
    const digest = createHmac('sha1', salt).update(hostname, 'utf8').digest('base64').replace(/=+$/, '')
    return digest === expected
  } catch {
    return false
  }
}

/** Host names a known_hosts entry may use for this connection (OpenSSH rules). */
export function knownHostCandidates(host: string, port: number): string[] {
  return port === DEFAULT_SSH_PORT ? [host] : [`[${host}]:${port}`]
}

/** Does this entry's host field cover the connection we are making? */
function entryCoversHost(entry: KnownHostLine, host: string, port: number): boolean {
  const candidates = knownHostCandidates(host, port)
  return entry.patterns.some((pattern) =>
    pattern.startsWith('|') ? matchesHashedPattern(pattern, host) : candidates.includes(pattern))
}

/**
 * Key types known_hosts already records for this host:port (deduped, wire names).
 *
 * Used two ways: for an accurate diagnostic when the presented type is not
 * recorded, and to prefer a recorded type during negotiation — a server usually
 * offers several (ssh-rsa / ecdsa / ed25519) and choosing one the user already
 * trusts avoids a spurious "host key not found" that reads as "never logged in".
 */
export function recordedHostKeyTypes(knownHostsText: string, host: string, port: number): string[] {
  const types: string[] = []
  for (const entry of parseKnownHosts(knownHostsText)) {
    if (!entryCoversHost(entry, host, port)) continue
    if (!types.includes(entry.keyType)) types.push(entry.keyType)
  }
  return types
}

/**
 * Client host-key algorithm preference: the types recorded for this host first,
 * then ssh2's standard list as a fallback.
 *
 * Only *ordering* changes; verification stays strict (the presented key must
 * match a known_hosts entry of the same type), so preferring a recorded type can
 * only reduce friction, never weaken the check. The fallback keeps a
 * rotated/missing type surfacing as a verification error with a clear message
 * rather than an opaque "no matching host key format".
 *
 * Mirrors ssh2's DEFAULT_SERVER_HOST_KEY; extend it if ssh2's list changes.
 */
export const DEFAULT_HOST_KEY_ALGORITHMS: readonly ServerHostKeyAlgorithm[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
]



/**
 * Ordering only: recorded types first, then the standard list. Verification is
 * unchanged (see verifyHostKeyAgainstKnownHosts) — a presented key must still
 * match a known_hosts entry of the same type, so this cannot weaken the check.
 */
export function hostKeyAlgorithmPreference(recorded: readonly string[]): ServerHostKeyAlgorithm[] {
  // known_hosts holds SSH wire names; ssh2 only ever negotiates those names.
  const preferred = recorded.slice() as ServerHostKeyAlgorithm[]
  for (const type of DEFAULT_HOST_KEY_ALGORITHMS) {
    if (!preferred.includes(type)) preferred.push(type)
  }
  return preferred
}

/** ssh2 algorithm config built from what known_hosts already trusts for the host. */
export function hostKeyAlgorithmsFor(knownHostsText: string, host: string, port: number): ServerHostKeyAlgorithm[] {
  return hostKeyAlgorithmPreference(recordedHostKeyTypes(knownHostsText, host, port))
}

/**
 * Strict verification: is `keyBlob` already trusted for host:port?
 * Returns a reason string when refused so callers can show an actionable error.
 */
export function verifyHostKeyAgainstKnownHosts(options: {
  knownHostsText: string
  host: string
  port: number
  keyBlob: Buffer
}): { ok: true } | { ok: false; reason: string } {
  const keyType = sshKeyTypeOf(options.keyBlob)
  if (keyType === undefined) return { ok: false, reason: 'SSH 服务器返回的公钥格式无法识别' }
  const keyBase64 = sshKeyBase64(options.keyBlob)
  const hostEntries = parseKnownHosts(options.knownHostsText)
    .filter((entry) => entryCoversHost(entry, options.host, options.port))

  if (hostEntries.some((entry) => entry.markers.includes('revoked'))) {
    return { ok: false, reason: `${options.host}:${options.port} 的公钥已被标记为 @revoked` }
  }

  const sameType = hostEntries.filter((entry) => entry.keyType === keyType)
  if (sameType.some((entry) => entry.keyBase64 === keyBase64)) return { ok: true }
  if (sameType.length > 0) {
    return { ok: false, reason: `${options.host}:${options.port} 的公钥与 known_hosts 中记录不一致（可能被更换或存在中间人攻击）` }
  }

  // Known host, unknown *key type*: the multi-key server case (rsa + ecdsa +
  // ed25519), which is NOT the same thing as "never logged in".
  const recorded = recordedHostKeyTypes(options.knownHostsText, options.host, options.port)
  if (recorded.length > 0) {
    return {
      ok: false,
      reason: `known_hosts 中 ${options.host}:${options.port} 只记录了 ${recorded.join('、')} 类型的主机密钥，本次协商到的是 ${keyType}（同一台服务器通常同时提供多种类型）。可补充该类型的记录：ssh-keyscan -p ${options.port} ${options.host} >> ~/.ssh/known_hosts`,
    }
  }

  const hint = options.port === DEFAULT_SSH_PORT ? options.host : `[${options.host}]:${options.port}`
  return { ok: false, reason: `known_hosts 中没有 ${options.host}:${options.port} 的记录（严格校验，不接受首次信任；非 22 端口在 known_hosts 中记作 ${hint}）` }
}

/* ── tunnel ──────────────────────────────────────────────────────────────── */

export interface SshTunnelHandle {
  profileName: string
  sshEndpoint: string
  /** Local 127.0.0.1 port the database driver should connect to. */
  localPort: number
  targetEndpoint: string
  close(): Promise<void>
}

export interface OpenTunnelOptions {
  profile: SshProfileSpec
  /** The database endpoint as seen FROM the jump host. */
  targetHost: string
  targetPort: number
  /** Resolve `$ENV:VAR` / `enc:v1:` secrets (defaults to secrets.resolvePassword). */
  resolveSecret?: (raw: string) => string
  /** Test seam: connect to this local port instead of the real SSH endpoint. */
  hostOverride?: { host: string; port: number }
}

function expandHome(filePath: string): string {
  if (filePath === '~') return os.homedir()
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) return path.join(os.homedir(), filePath.slice(2))
  return filePath
}

/** The auth facts needed to print a copy-pasteable manual `ssh` command. */
export interface ManualSshHintInput {
  host: string
  port: number
  username: string
  /** Profile auth method, plus its key path when it authenticates with a key file. */
  auth?: { method: SshAuthSpec['method']; keyPath?: string }
}

/** Quote an argument only when cmd / PowerShell would otherwise split it. */
function shellArg(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

/**
 * The exact `ssh` command a human can paste into PowerShell or cmd to log in
 * once — that first login is what writes the host key into known_hosts.
 * Ports other than 22 need `-p`, key-file auth needs `-i`, and a custom
 * known_hosts file needs `-o UserKnownHostsFile=…` (otherwise the key lands in
 * the default file and the plugin would still refuse it).
 */
export function manualSshCommand(input: ManualSshHintInput & { knownHostsPath?: string }): string {
  const parts = ['ssh']
  if (input.port !== DEFAULT_SSH_PORT) parts.push('-p', String(input.port))
  const keyPath = input.auth?.method === 'keyfile' ? (input.auth.keyPath ?? '').trim() : ''
  if (keyPath !== '') parts.push('-i', shellArg(expandHome(keyPath)))
  const knownHosts = input.knownHostsPath === undefined ? '' : expandHome(input.knownHostsPath)
  const defaultKnownHosts = path.join(os.homedir(), '.ssh', 'known_hosts')
  if (knownHosts !== '' && path.resolve(knownHosts) !== path.resolve(defaultKnownHosts)) {
    parts.push('-o', shellArg(`UserKnownHostsFile=${knownHosts}`))
  }
  parts.push(`${input.username}@${input.host}`)
  return parts.join(' ')
}

/**
 * Copy-pasteable fix for "this host key is not in known_hosts".
 * A generic "ssh once first" left users without any command to type, so this
 * spells out one command for their auth method, the file it must land in, and
 * a non-interactive fallback.
 */
export function knownHostsFixHint(input: ManualSshHintInput & {
  knownHostsPath: string
  /** Fetch exactly this key type (multi-key server where the type is missing). */
  keyType?: string
}): string {
  const endpoint = input.port === DEFAULT_SSH_PORT ? input.host : `${input.host}:${input.port}`
  const knownHosts = expandHome(input.knownHostsPath)
  const portFlag = input.port === DEFAULT_SSH_PORT ? '' : ` -p ${input.port}`
  const typeFlag = input.keyType === undefined ? '' : ` -t ${input.keyType}`
  const lines = [
    `在 PowerShell 或 cmd 里手动登录一次 ${endpoint}（核对指纹后输入 yes，主机密钥即写入 known_hosts）：`,
    `  ${manualSshCommand(input)}`,
    `目标文件：${knownHosts}`,
  ]
  const method = input.auth?.method
  if (method === 'password') lines.push('（该命令会提示输入跳板机账号的密码）')
  if (method === 'key') lines.push('（内联 PEM 无法直接交给 ssh：请改用密码或 ssh-agent 登录一次，或把 PEM 存成文件后用 -i 指定）')
  if (method === 'keyfile' && (input.auth?.keyPath ?? '').trim() === '') lines.push('（未填写私钥路径：命令使用默认私钥，非默认私钥请加 -i <私钥文件>）')
  lines.push('若无法交互登录（无人值守），可只取公钥——务必先与服务器管理员核对指纹：')
  lines.push(`  ssh-keyscan${portFlag}${typeFlag} ${input.host} >> ${shellArg(knownHosts)}`)
  return lines.join('\n')
}

/** Windows OpenSSH agent named pipe; POSIX uses SSH_AUTH_SOCK. */
function defaultAgentPath(): string | undefined {
  const fromEnv = process.env.SSH_AUTH_SOCK
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent'
  return undefined
}

function buildAuth(auth: SshAuthSpec, resolveSecret: (raw: string) => string): Partial<ConnectConfig> {
  const passphrase = auth.passphrase === undefined ? undefined : resolveSecret(auth.passphrase)
  switch (auth.method) {
    case 'agent': {
      const agent = defaultAgentPath()
      if (agent === undefined) {
        throw new SshError('config', 'SSH agent 认证不可用：未找到 SSH_AUTH_SOCK（Windows 请确认 OpenSSH Authentication Agent 服务已启动）')
      }
      return { agent }
    }
    case 'keyfile': {
      const file = expandHome(auth.keyPath ?? '')
      let material: Buffer
      try {
        material = fs.readFileSync(file)
      } catch (error) {
        throw new SshError('config', `无法读取 SSH 私钥文件 ${file}：${error instanceof Error ? error.message : String(error)}`)
      }
      return { privateKey: material, ...(passphrase === undefined ? {} : { passphrase }) }
    }
    case 'key': {
      if (auth.privateKey === undefined) throw new SshError('config', 'SSH 认证方式 key 缺少 privateKey')
      return { privateKey: resolveSecret(auth.privateKey), ...(passphrase === undefined ? {} : { passphrase }) }
    }
    case 'password': {
      if (auth.password === undefined) throw new SshError('config', 'SSH 认证方式 password 缺少 password')
      return { password: resolveSecret(auth.password) }
    }
  }
}

/** Map ssh2 / socket failures onto the plugin's error kinds. */
function classifySshFailure(error: unknown, context: string): SshError {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof SshError) return error
  if (/authentication|all configured authentication methods failed|permission denied/i.test(message)) {
    return new SshError('auth', `${context}：SSH 认证失败（${message}）`)
  }
  if (/timed? ?out|timeout/i.test(message)) return new SshError('timeout', `${context}：SSH 连接超时（${message}）`)
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE/i.test(message)) {
    return new SshError('network', `${context}：SSH 网络不可达（${message}）`)
  }
  return new SshError('config', `${context}：${message}`)
}

/** Options shared by the tunnel and the plain connectivity probe. */
export interface SshConnectOptions {
  /** Resolve `$ENV:VAR` / `enc:v1:` secrets (defaults to secrets.resolvePassword). */
  resolveSecret?: (raw: string) => string
  /** Test seam: connect to this local port instead of the real SSH endpoint. */
  hostOverride?: { host: string; port: number }
}

interface SshConnection {
  client: Client
  endpoint: string
  context: string
  close: () => void
}

/**
 * Connect + authenticate to the jump host with strict host-key verification.
 * Shared by the tunnel and by `probeSshProfile`, so a "test this SSH
 * configuration" click exercises exactly the same handshake a real connection
 * will perform.
 */
async function connectSsh(profile: SshProfileSpec, options: SshConnectOptions): Promise<SshConnection> {
  const resolveSecret = options.resolveSecret ?? resolvePassword
  const sshHost = options.hostOverride?.host ?? profile.host
  const sshPort = options.hostOverride?.port ?? profile.port ?? DEFAULT_SSH_PORT
  const endpoint = `${profile.host}:${profile.port ?? DEFAULT_SSH_PORT}`
  const context = `SSH 连接（配置 ${profile.name} → ${endpoint}）`

  const knownHostsPath = expandHome(profile.knownHostsPath ?? DEFAULT_KNOWN_HOSTS)

  /**
   * One actionable block reused by every "host key is not trusted" failure:
   * the exact `ssh` command for this profile's auth method, the file the key
   * must land in, and a non-interactive fallback.
   */
  const manualHint = (extra?: { keyType?: string }): string =>
    knownHostsFixHint({
      host: profile.host,
      port: profile.port ?? DEFAULT_SSH_PORT,
      username: profile.username,
      auth: {
        method: profile.auth.method,
        ...(profile.auth.keyPath === undefined ? {} : { keyPath: profile.auth.keyPath }),
      },
      knownHostsPath,
      ...(extra?.keyType === undefined ? {} : { keyType: extra.keyType }),
    })

  let knownHostsText: string
  try {
    knownHostsText = fs.readFileSync(knownHostsPath, 'utf8')
  } catch (error) {
    throw new SshError(
      'config',
      `${context}：无法读取 known_hosts（${knownHostsPath}）：${error instanceof Error ? error.message : String(error)}。主机密钥为严格校验，需先把该主机密钥写入这个文件；若这不是你想用的文件，请在 SSH 配置里改 knownHostsPath`,
      manualHint(),
    )
  }

  const auth = buildAuth(profile.auth, resolveSecret)
  const client = new Client()

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      try {
        client.end()
      } catch {
        /* ignore */
      }
      reject(classifySshFailure(error, context))
    }

    client.on('error', fail)
    client.on('timeout', () => fail(new SshError('timeout', `${context}：SSH 握手超时`)))
    client.on('ready', () => {
      if (settled) return
      settled = true
      // Keep an error listener attached: an EventEmitter 'error' with no
      // listener would throw once the connection drops later on.
      client.removeListener('error', fail)
      client.on('error', () => { /* post-ready transport errors are handled by callers/sockets */ })
      resolve()
    })

    const connectConfig: ConnectConfig = {
      host: sshHost,
      port: sshPort,
      username: profile.username,
      readyTimeout: profile.readyTimeoutMs ?? 20_000,
      ...(profile.keepaliveIntervalMs === undefined ? { keepaliveInterval: 10_000 } : { keepaliveInterval: profile.keepaliveIntervalMs }),
      ...auth,
      algorithms: {
        // Try a key type the user already trusts FIRST. Servers commonly publish
        // ssh-rsa + ecdsa + ed25519 while known_hosts only holds the one the user
        // accepted; without this ssh2's own preference (ed25519 first) can pick a
        // type that has no record, which looks like "you never logged in".
        // (ssh2 names this list `serverHostKey`.)
        serverHostKey: hostKeyAlgorithmsFor(knownHostsText, profile.host, profile.port ?? DEFAULT_SSH_PORT),
      },
      // Strict: reject anything not already present in known_hosts. ssh2 calls
      // this synchronously with the raw SSH wire-format public key.
      hostVerifier: (key: Buffer) => {
        const port = profile.port ?? DEFAULT_SSH_PORT
        const verdict = verifyHostKeyAgainstKnownHosts({ knownHostsText, host: profile.host, port, keyBlob: key })
        if (!verdict.ok) {
          // Name the exact key type only when the host IS recorded but this type
          // is missing — then `ssh-keyscan -t <type>` is what fills the gap.
          const recorded = recordedHostKeyTypes(knownHostsText, profile.host, port)
          const presented = sshKeyTypeOf(key)
          const extra: { keyType?: string } = recorded.length > 0 && presented !== undefined ? { keyType: presented } : {}
          throw new SshError('config', `${context}：${verdict.reason}`, manualHint(extra))
        }
        return true
      },
    }
    try {
      client.connect(connectConfig)
    } catch (error) {
      fail(error)
    }
  })

  return {
    client,
    endpoint,
    context,
    close: () => {
      try {
        client.end()
      } catch {
        /* already closed */
      }
    },
  }
}

/**
 * Validate one SSH configuration end to end: host reachability, host key
 * verification and authentication (agent / key file / inline key / password).
 * No port forwarding is attempted, so a success means "the credentials and the
 * known_hosts entry are right".
 */
export async function probeSshProfile(profile: SshProfileSpec, options?: SshConnectOptions): Promise<{ latencyMs: number; endpoint: string }> {
  const started = Date.now()
  const connection = await connectSsh(profile, options ?? {})
  const latencyMs = Date.now() - started
  connection.close()
  return { latencyMs, endpoint: connection.endpoint }
}

/**
 * Open an SSH connection to the jump host and expose a local port that forwards
 * to `targetHost:targetPort` as resolved from the jump host's perspective.
 */
export async function openSshTunnel(options: OpenTunnelOptions): Promise<SshTunnelHandle> {
  const { profile } = options
  const connection = await connectSsh(profile, options)
  const { client, endpoint, context } = connection
  let server: net.Server | undefined
  /** Live forwarded sockets, destroyed when the tunnel closes. */
  const sockets = new Set<net.Socket>()

  const handle: SshTunnelHandle = {
    profileName: profile.name,
    sshEndpoint: endpoint,
    localPort: 0,
    targetEndpoint: `${options.targetHost}:${options.targetPort}`,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      if (server !== undefined) {
        const current = server
        server = undefined
        await new Promise<void>((resolve) => current.close(() => resolve()))
      }
      connection.close()
    },
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      void handle.close()
      reject(classifySshFailure(error, context))
    }

    // The jump host must accept a forward to the database endpoint.
    server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => socket.destroy())
      client.forwardOut(socket.localAddress ?? '127.0.0.1', socket.localPort ?? 0, options.targetHost, options.targetPort, (error, stream) => {
        if (error !== null && error !== undefined) {
          socket.destroy()
          return
        }
        socket.pipe(stream).pipe(socket)
        stream.on('error', () => socket.destroy())
        socket.on('close', () => stream.destroy())
      })
    })
    server.on('error', fail)
    // Bind loopback only: never expose the tunnel to the LAN.
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server?.address()
      if (address === undefined || address === null || typeof address === 'string') {
        fail(new SshError('config', `${context}：无法确定本地转发端口`))
        return
      }
      handle.localPort = address.port
      if (settled) return
      settled = true
      resolve()
    })
  })

  return handle
}
