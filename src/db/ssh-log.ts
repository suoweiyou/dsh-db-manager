/**
 * FR-22 — read-only remote logs over SSH (v0.22).
 *
 * Why SFTP instead of a shell command: a `tail`/`grep` command would have to be
 * built from *something*, and every builder is one escaping bug away from
 * arbitrary code execution on a production host. Here the caller supplies only
 * a whitelisted source name; the path (or systemd unit) comes from the config
 * file. The transport then uses:
 *   - `kind: 'file'`    → SFTP `stat` + `createReadStream({ start })`, i.e. a
 *     read-only byte window at the end of the file. The code contains no
 *     write/rename/unlink/mkdir/chmod call site at all — the capability is
 *     absent, not merely disabled.
 *   - `kind: 'journal'` → `exec` with a FIXED template
 *     `journalctl --no-pager --output=short-iso -n N [-u <unit>] [--since '<t>']`
 *     where `unit` was validated at save time against `^[A-Za-z0-9@._:-]{1,64}$`
 *     and `--since` only accepts `-<n><s|min|h|d>` or `YYYY-MM-DD[ HH:MM[:SS]]`.
 *
 * Two hops (`logSources[].via`): the declaring profile is the entry point (the
 * jump host); the named `via` profile is the machine that actually holds the
 * log. We open a `direct-tcpip` channel on the first hop and run a second SSH
 * transport over it — again pure SFTP/journal, no shell on the jump host.
 *
 * Connection lifecycle (D8): one `LogSession` per tool call, reused across every
 * source on the same target and closed at the end. Nothing is cached between
 * calls, so there is no cross-turn state to leak or to invalidate.
 */
import type { Readable } from 'node:stream'
import type { Client, SFTPWrapper } from 'ssh2'
import { SshError, connectSsh, type SshConnectOptions, type SshConnection } from './ssh-tunnel.js'
import type { SshLogKind, SshLogSourceSpec, SshProfileSpec } from '../shared/types.js'

/** v0.22 default output quota (the `logMaxBytes` plugin config defaults to this). */
export const DEFAULT_LOG_MAX_BYTES = 100_000
/** Hard line ceiling — guards against a file of 3-character lines flooding the result. */
export const MAX_LOG_LINES = 2000
/** Longest single log line we echo; keeps one pathological JSON blob from eating the quota. */
export const MAX_LINE_CHARS = 2000
export const DEFAULT_LOG_TIMEOUT_MS = 10_000
/** Default number of lines when the caller does not ask for a specific count. */
export const DEFAULT_LOG_LINES = 200

/** systemd unit names `journalctl -u` accepts; anything else could smuggle shell syntax. */
const UNIT_PATTERN = /^[A-Za-z0-9@._:-]{1,64}$/
/** `--since` accepts only a relative age or an absolute timestamp (no free text). */
const SINCE_RELATIVE = /^-\d{1,4}(s|m|h|d|sec|min|hour|day)s?$/i
const SINCE_ABSOLUTE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/

/* ── pure helpers (unit-tested) ──────────────────────────────────────────── */

export interface TailWindowResult {
  lines: string[]
  /** Lines present in the sampled window before the per-call line cap. */
  scannedLines: number
  truncated: boolean
  /** Bytes actually read from the end of the file / journal stream. */
  windowBytes: number
}

/**
 * Cut a readable window out of the END of a buffer: that is what "show me the
 * last N lines" means for a log, and it keeps the read bounded regardless of
 * how large the file is.
 *
 * Two bounds apply, in this order: bytes (never read/keep more than `maxBytes`)
 * then lines (keep at most `maxLines`). A window that starts mid-line drops the
 * partial first line — a half line is noise, not evidence.
 */
export function tailWindow(buffer: Buffer, options: { maxLines: number; maxBytes: number }): TailWindowResult {
  const maxLines = clampInt(options.maxLines, 1, MAX_LOG_LINES)
  const maxBytes = clampInt(options.maxBytes, 1, 50 * 1024 * 1024)
  const size = buffer.length
  if (size === 0) return { lines: [], scannedLines: 0, truncated: false, windowBytes: 0 }

  let start = Math.max(0, size - maxBytes)
  if (start > 0) {
    // Skip the partial leading line produced by cutting in the middle of the file.
    const newline = buffer.indexOf(0x0a, start)
    if (newline < 0) return { lines: [], scannedLines: 0, truncated: true, windowBytes: size - start }
    start = newline + 1
  }
  const text = buffer.subarray(start, size).toString('utf8')
  const raw = text.split('\n')
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  const allLines = raw.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  const truncated = start > 0 || allLines.length > maxLines
  const lines = allLines.length > maxLines ? allLines.slice(allLines.length - maxLines) : allLines
  return { lines, scannedLines: allLines.length, truncated, windowBytes: size - start }
}

/** Case-insensitive substring match, applied locally after the window is read. */
export function filterKeyword(lines: readonly string[], keyword: string | undefined): string[] {
  const needle = (keyword ?? '').trim()
  if (needle.length === 0) return [...lines]
  const lower = needle.toLowerCase()
  return lines.filter((line) => line.toLowerCase().includes(lower))
}

/** Cap one line at MAX_LINE_CHARS so a single huge line cannot eat the quota. */
export function clampLine(line: string): string {
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS)}…（本行已截断）`
}

/** Validate a `--since` value; the only two accepted shapes, nothing free-form. */
export function validateJournalSince(since: string): { ok: true; value: string } | { ok: false; reason: string } {
  const value = since.trim()
  if (SINCE_RELATIVE.test(value) || SINCE_ABSOLUTE.test(value)) return { ok: true, value }
  return {
    ok: false,
    reason: 'since 只接受两种写法：相对时间（如 -30min、-2h、-7d）或绝对时间（如 2026-10-29、2026-10-29 09:30[:00]）',
  }
}

/**
 * The exact command line for a journal read. Deliberately assembled from
 * validated pieces only, and every piece is re-checked here (not just at save
 * time) so a hand-edited config file cannot bypass validation.
 */
export function journalArgv(options: { unit?: string; lines: number; since?: string }): string {
  const lineCount = clampInt(options.lines, 1, MAX_LOG_LINES)
  const parts = ['journalctl', '--no-pager', '--output=short-iso', '-n', String(lineCount)]
  if (options.unit !== undefined && options.unit.length > 0) {
    if (!UNIT_PATTERN.test(options.unit)) {
      throw new SshError('config', `systemd 单元名不合法：${options.unit}（只允许字母、数字与 @ . _ : - ，长度 1–64）`)
    }
    parts.push('-u', options.unit)
  }
  if (options.since !== undefined && options.since.trim().length > 0) {
    const since = validateJournalSince(options.since)
    if (!since.ok) throw new SshError('config', since.reason)
    // Single quotes are safe here: the value matched one of two patterns, so it
    // contains no quote character at all.
    parts.push('--since', `'${since.value}'`)
  }
  return parts.join(' ')
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  const rounded = Math.trunc(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/* ── one raw sample from one source ──────────────────────────────────────── */

export interface LogSample {
  source: SshLogSourceSpec
  kind: SshLogKind
  /** Absolute path / unit name, echoed back so the model can confirm what it read. */
  target: string
  buffer: Buffer
  windowBytes: number
}

export interface LogReadOptions {
  /** Requested line count (clamped to MAX_LOG_LINES). */
  lines?: number
  maxBytes: number
  timeoutMs: number
  /** journal only: relative/absolute age, validated by journalArgv. */
  since?: string
}

/** A live SSH side-channel that can read several whitelisted sources. */
export interface LogSession {
  profileName: string
  viaName?: string
  read(source: SshLogSourceSpec, options: LogReadOptions): Promise<LogSample>
  close(): void
}

export interface OpenLogSessionOptions {
  /** Entry-point SSH profile (the jump host when `viaProfile` is set). */
  profile: SshProfileSpec
  /** Second hop: the machine that actually holds the logs. */
  viaProfile?: SshProfileSpec
  resolveSecret?: SshConnectOptions['resolveSecret']
  /** Test seam: connect the FIRST hop to this endpoint. */
  hostOverride?: { host: string; port: number }
}

/**
 * Open the SSH side-channel for one target machine. Every source of that
 * machine is then read on this connection and `close()` tears down both hops.
 */
export async function openLogSession(options: OpenLogSessionOptions): Promise<LogSession> {
  const first = await connectSsh(options.profile, {
    ...(options.resolveSecret === undefined ? {} : { resolveSecret: options.resolveSecret }),
    ...(options.hostOverride === undefined ? {} : { hostOverride: options.hostOverride }),
  })
  let second: SshConnection | undefined
  let client: Client = first.client
  try {
    if (options.viaProfile !== undefined) {
      const stream = await forwardOut(first.client, options.viaProfile)
      second = await connectSsh(options.viaProfile, {
        ...(options.resolveSecret === undefined ? {} : { resolveSecret: options.resolveSecret }),
        sock: stream,
      })
      client = second.client
    }
    // SFTP is opened lazily: a journal-only host needs no sftp subsystem, and
    // many hardened servers disable it while keeping exec/journalctl available.
    let sftp: SFTPWrapper | undefined
    const ensureSftp = async (): Promise<SFTPWrapper> => {
      if (sftp === undefined) sftp = await openSftp(client)
      return sftp
    }
    const target = client
    const session: LogSession = {
      profileName: options.profile.name,
      ...(options.viaProfile === undefined ? {} : { viaName: options.viaProfile.name }),
      async read(source, readOptions) {
        const windowBytes = clampInt(readOptions.maxBytes, 1, 50 * 1024 * 1024)
        if (source.kind === 'journal') {
          const buffer = await runJournal(target, source.unit ?? '', {
            lines: readOptions.lines ?? DEFAULT_LOG_LINES,
            maxBytes: windowBytes,
            timeoutMs: readOptions.timeoutMs,
            ...(readOptions.since === undefined ? {} : { since: readOptions.since }),
          })
          return { source, kind: source.kind, target: `journal:${source.unit ?? '?'}`, buffer, windowBytes: buffer.length }
        }
        const path = source.path ?? ''
        const buffer = await readFileTail(await ensureSftp(), path, windowBytes, readOptions.timeoutMs)
        return { source, kind: source.kind, target: path, buffer, windowBytes: buffer.length }
      },
      close() {
        try {
          sftp?.end()
        } catch {
          /* already closed */
        }
        if (second !== undefined) second.close()
        first.close()
      },
    }
    return session
  } catch (error) {
    if (second !== undefined) second.close()
    first.close()
    throw error
  }
}

/** `direct-tcpip` channel from the first hop to the second machine's SSH port. */
function forwardOut(client: Client, viaProfile: SshProfileSpec): Promise<Readable> {
  const port = viaProfile.port ?? 22
  return new Promise<Readable>((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, viaProfile.host, port, (error, stream) => {
      if (error !== undefined && error !== null) {
        reject(
          new SshError(
            'network',
            `经跳板机转发到 ${viaProfile.host}:${port} 失败：${error.message}。请确认跳板机到目标机的网络可达，且目标机 SSH 端口正确`,
          ),
        )
        return
      }
      resolve(stream as unknown as Readable)
    })
  })
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error !== undefined && error !== null) {
        reject(
          new SshError(
            'config',
            `目标服务器未开启 SFTP 子系统（${error.message}）。可改用 kind=journal 的日志源，或联系运维开启 sftp subsystem`,
          ),
        )
        return
      }
      resolve(sftp)
    })
  })
}

/** Read the last `maxBytes` of a remote file through SFTP (read-only handle). */
async function readFileTail(sftp: SFTPWrapper, path: string, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  if (path.length === 0) throw new SshError('config', '日志源缺少文件路径')
  const stats = await withTimeout(
    new Promise<{ size: number }>((resolve, reject) => {
      sftp.stat(path, (error, value) => {
        if (error !== undefined && error !== null) {
          reject(mapSftpError(error, path))
          return
        }
        resolve({ size: value.size })
      })
    }),
    timeoutMs,
    `读取 ${path} 的文件信息超时（${timeoutMs}ms）`,
  )
  if (stats.size === 0) return Buffer.alloc(0)
  const start = Math.max(0, stats.size - maxBytes)
  return withTimeout(
    collectStream(sftp.createReadStream(path, { start, end: stats.size - 1 }), maxBytes),
    timeoutMs,
    `读取 ${path} 超时（${timeoutMs}ms）`,
  )
}

/** SFTP status codes are numbers; 2 = ENOENT, 3 = EACCES. */
function mapSftpError(error: Error & { code?: number | string }, path: string): SshError {
  const code = error.code
  const message = error.message
  if (code === 2 || /no such file/i.test(message)) {
    return new SshError('config', `日志文件不存在：${path}（检查配置里的路径是否写错，或日志是否已轮转）`)
  }
  if (code === 3 || /permission denied/i.test(message)) {
    return new SshError('permission', `没有读取 ${path} 的权限（该 SSH 账号是否在日志所属用户组里？）`)
  }
  return new SshError('config', `读取 ${path} 失败：${message}`)
}

/** Drain a stream into a tail buffer, never keeping more than `maxBytes`. */
function collectStream(stream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    const finish = () => {
      const joined = Buffer.concat(chunks)
      resolve(joined.length <= maxBytes ? joined : joined.subarray(joined.length - maxBytes))
    }
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.length
      // Keep a small slack so tailWindow can drop one partial leading line.
      while (total > maxBytes && chunks.length > 1) {
        const dropped = chunks.shift()!
        total -= dropped.length
      }
    })
    stream.on('error', (error: Error) => reject(mapSftpError(error, '日志文件')))
    stream.on('end', finish)
  })
}

/** Run the fixed journal command and keep the newest `maxBytes` of its output. */
function runJournal(
  client: Client,
  unit: string,
  options: { lines: number; maxBytes: number; timeoutMs: number; since?: string },
): Promise<Buffer> {
  const command = journalArgv({
    ...(unit.length === 0 ? {} : { unit }),
    lines: options.lines,
    ...(options.since === undefined ? {} : { since: options.since }),
  })
  return withTimeout(
    new Promise<Buffer>((resolve, reject) => {
      client.exec(command, (error, channel) => {
        if (error !== undefined && error !== null) {
          reject(
            new SshError(
              'config',
              `无法执行 journalctl（${error.message}）。目标机可能没有 systemd/journalctl，或该账号不允许执行命令`,
            ),
          )
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        let stderr = ''
        const keep = () => {
          const joined = Buffer.concat(chunks)
          return joined.length <= options.maxBytes ? joined : joined.subarray(joined.length - options.maxBytes)
        }
        channel.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          total += chunk.length
          while (total > options.maxBytes && chunks.length > 1) {
            const dropped = chunks.shift()!
            total -= dropped.length
          }
        })
        channel.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8')
        })
        channel.on('close', (code: number | null) => {
          if (code !== null && code !== 0 && chunks.length === 0) {
            const detail = stderr.trim()
            if (/not found|No such file/i.test(detail) || /command not found/i.test(detail)) {
              reject(new SshError('config', `目标机没有 journalctl（${detail || `退出码 ${code}`}）：不是 systemd 系统或为精简镜像`))
              return
            }
            if (/permission|denied/i.test(detail)) {
              reject(new SshError('permission', `没有读取 journal 的权限（${detail}）：把该账号加入 systemd-journal 组后重试`))
              return
            }
            reject(new SshError('config', `journalctl 退出码 ${code}：${detail || '无输出'}`))
            return
          }
          resolve(keep())
        })
        channel.on('error', (streamError: Error) => reject(new SshError('network', `journal 通道错误：${streamError.message}`)))
      })
    }),
    options.timeoutMs,
    `读取 journal 超时（${options.timeoutMs}ms）`,
  )
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new SshError('timeout', message))
    }, timeoutMs)
    // Do not keep the event loop alive just for this timer.
    if (typeof timer.unref === 'function') timer.unref()
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error instanceof Error ? error : new SshError('network', String(error)))
      },
    )
  })
}

/* ── result shaping ──────────────────────────────────────────────────────── */

export interface SshLogReadResult {
  profile: string
  source: string
  kind: SshLogKind
  target: string
  via?: string
  lines: string[]
  lineCount: number
  scannedLines: number
  matched?: number
  truncated: boolean
  windowBytes: number
  maxBytes: number
  elapsedMs: number
}

/** Turn one raw sample + the caller's filters into the tool-facing result. */
export function shapeLogResult(input: {
  profile: string
  source: SshLogSourceSpec
  sample: LogSample
  lines?: number
  keyword?: string
  maxBytes: number
  elapsedMs: number
  via?: string
}): SshLogReadResult {
  const window = tailWindow(input.sample.buffer, {
    maxLines: input.lines ?? DEFAULT_LOG_LINES,
    maxBytes: input.maxBytes,
  })
  const clamped = window.lines.map(clampLine)
  const matched = filterKeyword(clamped, input.keyword)
  return {
    profile: input.profile,
    source: input.source.name,
    kind: input.sample.kind,
    target: input.sample.target,
    ...(input.via === undefined ? {} : { via: input.via }),
    lines: matched,
    lineCount: matched.length,
    scannedLines: window.scannedLines,
    ...(input.keyword === undefined || input.keyword.trim().length === 0 ? {} : { matched: matched.length }),
    truncated: window.truncated || matched.length < window.lines.length,
    windowBytes: input.sample.windowBytes,
    maxBytes: input.maxBytes,
    elapsedMs: input.elapsedMs,
  }
}
