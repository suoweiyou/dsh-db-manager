/**
 * FR-22 — model-facing tools for reading whitelisted server logs (v0.22).
 *
 * The whole point is the *conversation*: the model reads a log here, sees the
 * failing request, then searches the same trace id across other whitelisted
 * sources, then compares with the database through db_query.
 *
 * Security shape (see docs/开发计划-20261029-SSH只读日志.md §3.1):
 *   - tool arguments carry a source NAME only — never a path, never a command;
 *   - the transport is SFTP tail-read or a fixed-template journalctl;
 *   - the only output budget is `logMaxBytes` (default 100KB), applied per call.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AuditLog } from '../audit/log.js'
import { saveLogSourceInto } from '../config/mutate.js'
import type { ConfigStore } from '../config/store.js'
import {
  DEFAULT_LOG_LINES,
  MAX_LOG_LINES,
  clampLine,
  filterKeyword,
  openLogSession,
  shapeLogResult,
  tailWindow,
  validateJournalSince,
  type SshLogReadResult,
} from '../db/ssh-log.js'
import { toDbFailure } from '../db/errors.js'
import { resolveWorkspaceCwd } from './workspace.js'
import type { SshLogSourceSpec, SshProfileSpec } from '../shared/types.js'

export interface LogToolDeps {
  store: ConfigStore
  audit: AuditLog
  /** v0.22 output quota in bytes (defaults to 100000). */
  logMaxBytes: number
  /** v0.22 per-read timeout in ms (defaults to 10000). */
  logTimeoutMs: number
}

const SOURCE_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    kind: { type: 'string', required: true, enum: ['file', 'journal'] },
    target: { type: 'string', required: true },
    label: { type: 'string' },
    via: { type: 'string' },
  },
} as const

function sourceTarget(source: SshLogSourceSpec): string {
  return source.kind === 'journal' ? `journal:${source.unit ?? '?'}` : (source.path ?? '?')
}

interface SourceView {
  name: string
  kind: 'file' | 'journal'
  target: string
  label?: string
  via?: string
}

function sourceView(source: SshLogSourceSpec): SourceView {
  return {
    name: source.name,
    kind: source.kind,
    target: sourceTarget(source),
    ...(source.label === undefined ? {} : { label: source.label }),
    ...(source.via === undefined ? {} : { via: source.via }),
  }
}

/** Resolve the second-hop profile a source declares, with an actionable error. */
function resolveVia(
  store: ConfigStore,
  load: ReturnType<ConfigStore['load']>,
  profile: SshProfileSpec,
  source: SshLogSourceSpec,
): { viaProfile?: SshProfileSpec; error?: string } {
  if (source.via === undefined) return {}
  const via = store.visibleSshProfiles(load).find((entry) => entry.profile.name === source.via)
  if (via === undefined) {
    const names = store.visibleSshProfiles(load).map((entry) => entry.profile.name)
    return { error: `日志源 "${source.name}" 的 via 指向不存在的 SSH 配置 "${source.via}"（可用：${names.join('、') || '无'}）` }
  }
  if (via.profile.name === profile.name) return { error: `日志源 "${source.name}" 的 via 不能指向自身` }
  return { viaProfile: via.profile }
}

/** One source's slice of a cross-source search result. */
interface SearchGroup {
  profile: string
  source: string
  target: string
  matched: number
  scannedLines: number
  via?: string
  kind?: 'file' | 'journal'
  truncated?: boolean
  lines?: string[]
  error?: string
}

export function buildLogTools(deps: LogToolDeps): unknown[] {
  const maxBytes = deps.logMaxBytes

  const listLogs = defineTool({
    name: 'db_list_ssh_logs',
    description:
      'List the read-only log sources declared in dsh-db-manager SSH profiles (workspace + global). ' +
      'Returns, per SSH profile, the whitelisted sources: a name to pass to db_read_ssh_log / db_search_ssh_logs, ' +
      'the kind (file | journal) and the remote target (file path or systemd unit). ' +
      'Logs are the ONLY remote content this plugin can read: it cannot run commands, read arbitrary files or modify anything. ' +
      'When a source lists `via`, the log lives on a second machine reached through the profile host (jump host).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          profiles: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                profile: { type: 'string', required: true },
                host: { type: 'string', required: true },
                port: { type: 'integer' },
                scope: { type: 'string', required: true, enum: ['global', 'workspace'] },
                sources: { type: 'array', required: true, items: SOURCE_VIEW_SCHEMA },
              },
            },
          },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      } as const,
      render: (_args, value) => {
        const lines: string[] = []
        for (const profile of value.profiles) {
          lines.push(`${profile.profile}（${profile.host}:${profile.port ?? 22}，${profile.scope}）`)
          for (const source of profile.sources) {
            lines.push(`  - ${source.name} [${source.kind}] ${source.target}${source.via === undefined ? '' : ` 经 ${source.via}`}${source.label === undefined ? '' : ` — ${source.label}`}`)
          }
          if (profile.sources.length === 0) lines.push('  （未登记日志源）')
        }
        if (lines.length === 0) lines.push('（没有任何 SSH 配置：先在设置页「数据库 → SSH 配置」里新增，或让用户手工编辑配置文件）')
        for (const warning of value.warnings ?? []) lines.push(`警告：${warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      const cwd = resolveWorkspaceCwd(exec)
      const load = deps.store.load(cwd)
      const profiles = deps.store.visibleSshProfiles(load).map((entry) => ({
        profile: entry.profile.name,
        host: entry.profile.host,
        ...(entry.profile.port === undefined ? {} : { port: entry.profile.port }),
        scope: entry.scope,
        sources: (entry.profile.logSources ?? []).map(sourceView),
      }))
      return {
        ok: true,
        profiles,
        warnings: [...load.global.warnings, ...(load.workspace?.warnings ?? [])],
      }
    },
    presentCall: () => ({ card: 'generic', title: '列出服务器日志源', kind: 'read' }),
    isConcurrencySafe: () => true,
    timeoutMs: 5000,
  })

  const readLog = defineTool({
    name: 'db_read_ssh_log',
    description:
      'Read the tail of ONE whitelisted server log through SSH (read-only) and return it into this conversation for analysis. ' +
      'Use db_list_ssh_logs first to see the available `profile` / `source` names. ' +
      'The read is always the LAST `lines` lines of the file (or `journalctl -n N` for a journal source); `keyword` filters locally, ' +
      'case-insensitively, inside that window — it is NOT a full-file search. ' +
      'Output is capped by the plugin setting logMaxBytes (default 100KB): when `truncated` is true you received the newest lines only, ' +
      'so narrow the range with `keyword` or a smaller `lines` instead of retrying the same call. ' +
      'This tool cannot run commands, cannot read a file that is not declared in the SSH profile, and cannot modify anything. ' +
      'Logs may contain credentials or personal data — quote only what is needed.',
    parameters: {
      profile: { type: 'string', required: true, description: 'SSH profile name from db_list_ssh_logs.' },
      source: { type: 'string', required: true, description: 'Log source name declared in that profile.' },
      lines: { type: 'integer', description: `How many trailing lines to keep (1..${MAX_LOG_LINES}, default ${DEFAULT_LOG_LINES}). Also bounded by logMaxBytes.` },
      keyword: { type: 'string', description: 'Optional case-insensitive substring; only lines containing it are returned (matched inside the tail window).' },
      since: { type: 'string', description: 'journal sources only: -30min / -2h / -7d, or 2026-10-29[ 09:30[:00]]. Rejected for file sources.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          profile: { type: 'string' },
          source: { type: 'string' },
          kind: { type: 'string', enum: ['file', 'journal'] },
          target: { type: 'string' },
          via: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' } },
          lineCount: { type: 'integer' },
          scannedLines: { type: 'integer' },
          matched: { type: 'integer' },
          truncated: { type: 'boolean' },
          windowBytes: { type: 'integer' },
          maxBytes: { type: 'integer' },
          elapsedMs: { type: 'integer' },
          failureMessage: { type: 'string' },
          failureHint: { type: 'string' },
        },
      } as const,
      render: (_args, value) => {
        if (value.ok === false) {
          return [{ type: 'text', text: `读取日志失败：${value.failureMessage ?? '未知原因'}${value.failureHint === undefined ? '' : `\n建议：${value.failureHint}`}` }]
        }
        const head = `${value.profile}/${value.source}（${value.target}${value.via === undefined ? '' : ` 经 ${value.via}`}）：${value.lineCount} 行` +
          `${value.matched === undefined ? '' : `，命中 ${value.matched} 行`}，窗口 ${value.scannedLines} 行 / ${value.windowBytes} 字节` +
          `${value.truncated ? `（已截断，额度 ${value.maxBytes} 字节）` : ''}，耗时 ${value.elapsedMs}ms`
        return [{ type: 'text', text: [head, ...(value.lines ?? [])].join('\n') }]
      },
    },
    async execute(args, exec) {
      const started = Date.now()
      const record = (args ?? {}) as Record<string, unknown>
      const profileName = typeof record.profile === 'string' ? record.profile.trim() : ''
      const sourceName = typeof record.source === 'string' ? record.source.trim() : ''
      const keyword = typeof record.keyword === 'string' && record.keyword.trim().length > 0 ? record.keyword.trim().slice(0, 200) : undefined
      const since = typeof record.since === 'string' && record.since.trim().length > 0 ? record.since.trim() : undefined
      const requestedLines = typeof record.lines === 'number' ? record.lines : DEFAULT_LOG_LINES

      const fail = (message: string, hint?: string) => {
        deps.audit.record({
          ts: started,
          channel: 'tool',
          action: 'db_read_ssh_log',
          status: 'error',
          ...(profileName.length === 0 ? {} : { connection: profileName }),
          durationMs: Date.now() - started,
          detail: `${sourceName || '(无源)'} ${message}`,
        })
        return { ok: false, failureMessage: message, ...(hint === undefined ? {} : { failureHint: hint }) }
      }

      if (profileName.length === 0) return fail('缺少 profile 参数', '先调用 db_list_ssh_logs 查看可用的 SSH 配置与日志源')
      if (sourceName.length === 0) return fail('缺少 source 参数', '先调用 db_list_ssh_logs 查看该配置下的日志源名')

      const cwd = resolveWorkspaceCwd(exec)
      const load = deps.store.load(cwd)
      const resolved = deps.store.resolveLogSource(load, profileName, sourceName)
      if (resolved.resolved === undefined) {
        return fail(resolved.error ?? '无法解析日志源', '确认 profile / source 名称，或先调用 db_list_ssh_logs')
      }
      const { profile, source } = resolved.resolved
      if (since !== undefined) {
        if (source.kind !== 'journal') return fail('since 只适用于 journal 类型日志源', '文件日志请改用 lines / keyword 缩小范围')
        const checked = validateJournalSince(since)
        if (!checked.ok) return fail(checked.reason)
      }
      const via = resolveVia(deps.store, load, profile, source)
      if (via.error !== undefined) return fail(via.error, '检查该日志源的 via 字段')

      try {
        const session = await openLogSession({
          profile,
          ...(via.viaProfile === undefined ? {} : { viaProfile: via.viaProfile }),
        })
        try {
          const sample = await session.read(source, {
            lines: requestedLines,
            maxBytes,
            timeoutMs: deps.logTimeoutMs,
            ...(since === undefined ? {} : { since }),
          })
          const result = shapeLogResult({
            profile: profile.name,
            source,
            sample,
            lines: requestedLines,
            ...(keyword === undefined ? {} : { keyword }),
            maxBytes,
            elapsedMs: Date.now() - started,
            ...(session.viaName === undefined ? {} : { via: session.viaName }),
          })
          deps.audit.record({
            ts: started,
            channel: 'tool',
            action: 'db_read_ssh_log',
            status: 'ok',
            connection: profile.name,
            durationMs: result.elapsedMs,
            rowCount: result.lineCount,
            detail: `source=${source.name} kind=${source.kind} window=${result.windowBytes}B scanned=${result.scannedLines} kept=${result.lineCount}${result.truncated ? ' truncated' : ''}`,
          })
          return { ok: true, ...toResultPayload(result) }
        } finally {
          session.close()
        }
      } catch (error) {
        const failure = toDbFailure(error)
        return fail(failure.message, failure.hint)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `读取服务器日志${typeof args?.source === 'string' ? `：${args.source}` : ''}`, kind: 'read' }),
    isConcurrencySafe: () => true,
    timeoutMs: 30_000,
  })

  const searchLogs = defineTool({
    name: 'db_search_ssh_logs',
    description:
      'Search a keyword across MULTIPLE whitelisted log sources in ONE call (read-only, over SSH) — the fast way to follow a trace id, ' +
      'error code or interface name from the log that showed the failure into the other logs that may explain it. ' +
      'Each source contributes its tail window (same bounded read as db_read_ssh_log); matching is local and case-insensitive, so hits mean ' +
      '"present in the recent window", not "present in the whole file" — check `truncated` / `scannedLines` before concluding anything is absent. ' +
      'Omit `profile` to search every profile that has log sources, omit `sources` to search all of its sources. ' +
      'Total output is capped by logMaxBytes (default 100KB); narrow with `profile` / `sources` / `contextLines: 0` when it truncates.',
    parameters: {
      keyword: { type: 'string', required: true, description: 'Case-insensitive substring to look for (e.g. a trace id or "OutOfMemory").' },
      profile: { type: 'string', description: 'Limit the search to one SSH profile name (from db_list_ssh_logs).' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Limit the search to these source names (within the selected profile).' },
      contextLines: { type: 'integer', description: 'Lines of context around each hit (0..10, default 2). 0 = only the matching lines.' },
      lines: { type: 'integer', description: `Tail window per source (1..${MAX_LOG_LINES}, default 400).` },
      since: { type: 'string', description: 'journal sources only: -30min / -2h / -7d or 2026-10-29[ 09:30[:00]].' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          keyword: { type: 'string' },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                profile: { type: 'string', required: true },
                via: { type: 'string' },
                source: { type: 'string', required: true },
                kind: { type: 'string', enum: ['file', 'journal'] },
                target: { type: 'string', required: true },
                matched: { type: 'integer', required: true },
                scannedLines: { type: 'integer', required: true },
                truncated: { type: 'boolean' },
                lines: { type: 'array', items: { type: 'string' } },
                error: { type: 'string' },
              },
            },
          },
          totalMatched: { type: 'integer' },
          searchedSources: { type: 'integer' },
          truncated: { type: 'boolean' },
          maxBytes: { type: 'integer' },
          elapsedMs: { type: 'integer' },
          failureMessage: { type: 'string' },
          failureHint: { type: 'string' },
        },
      } as const,
      render: (_args, value) => {
        if (value.ok === false) {
          return [{ type: 'text', text: `跨源检索失败：${value.failureMessage ?? '未知原因'}${value.failureHint === undefined ? '' : `\n建议：${value.failureHint}`}` }]
        }
        const lines = [`关键字 "${value.keyword}"：在 ${value.searchedSources ?? 0} 个日志源里命中 ${value.totalMatched ?? 0} 行${value.truncated === true ? '（结果已截断）' : ''}，耗时 ${value.elapsedMs ?? 0}ms`]
        for (const group of value.groups ?? []) {
          lines.push(`\n## ${group.profile}/${group.source}（${group.target}${group.via === undefined ? '' : ` 经 ${group.via}`}）— 命中 ${group.matched} 行${group.truncated === true ? '，窗口已截断' : ''}`)
          if (group.error !== undefined) lines.push(`  （读取失败：${group.error}）`)
          for (const line of group.lines ?? []) lines.push(line)
        }
        if ((value.groups ?? []).length === 0) lines.push('（没有可检索的日志源）')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const started = Date.now()
      const record = (args ?? {}) as Record<string, unknown>
      const keyword = typeof record.keyword === 'string' ? record.keyword.trim() : ''
      const profileFilter = typeof record.profile === 'string' && record.profile.trim().length > 0 ? record.profile.trim() : undefined
      const sourceFilter = Array.isArray(record.sources) ? record.sources.filter((entry): entry is string => typeof entry === 'string') : undefined
      const contextLines = typeof record.contextLines === 'number' ? Math.max(0, Math.min(10, Math.trunc(record.contextLines))) : 2
      const windowLines = typeof record.lines === 'number' ? Math.max(1, Math.min(MAX_LOG_LINES, Math.trunc(record.lines))) : 400
      const since = typeof record.since === 'string' && record.since.trim().length > 0 ? record.since.trim() : undefined

      const fail = (message: string, hint?: string) => {
        deps.audit.record({
          ts: started,
          channel: 'tool',
          action: 'db_search_ssh_logs',
          status: 'error',
          durationMs: Date.now() - started,
          detail: message,
        })
        return { ok: false, failureMessage: message, ...(hint === undefined ? {} : { failureHint: hint }) }
      }

      if (keyword.length === 0) return fail('缺少 keyword 参数', '传入要在日志里找的关键字，例如 traceId、错误码或接口名')
      if (since !== undefined) {
        const checked = validateJournalSince(since)
        if (!checked.ok) return fail(checked.reason)
      }
      const cwd = resolveWorkspaceCwd(exec)
      const load = deps.store.load(cwd)
      const profiles = deps.store.visibleSshProfiles(load)
        .filter((entry) => profileFilter === undefined || entry.profile.name === profileFilter)
      if (profiles.length === 0) {
        return fail(profileFilter === undefined ? '没有任何 SSH 配置' : `SSH 配置 "${profileFilter}" 不存在`, '先调用 db_list_ssh_logs 查看可用配置与日志源')
      }

      // Collect the target sources first, so the byte budget can be shared and
      // each target machine gets exactly ONE SSH connection (D8).
      interface Target { profile: SshProfileSpec; viaProfile?: SshProfileSpec; source: SshLogSourceSpec }
      const targets: Target[] = []
      for (const entry of profiles) {
        for (const source of entry.profile.logSources ?? []) {
          if (sourceFilter !== undefined && sourceFilter.length > 0 && !sourceFilter.includes(source.name)) continue
          const via = resolveVia(deps.store, load, entry.profile, source)
          if (via.error !== undefined) {
            targets.push({ profile: entry.profile, source })
            continue
          }
          targets.push({ profile: entry.profile, source, ...(via.viaProfile === undefined ? {} : { viaProfile: via.viaProfile }) })
        }
      }
      if (targets.length === 0) {
        return fail('没有匹配的日志源', '检查 sources 名称，或先调用 db_list_ssh_logs')
      }

      // Fair share of the quota, but never so small that a read is useless.
      const perSourceBytes = Math.max(4000, Math.floor(maxBytes / targets.length))
      const groups: SearchGroup[] = []
      let remaining = maxBytes
      let totalMatched = 0
      let searched = 0
      let truncated = false

      const byTarget = new Map<string, Target[]>()
      for (const target of targets) {
        const key = `${target.profile.name}\u0000${target.viaProfile?.name ?? ''}`
        const list = byTarget.get(key)
        if (list === undefined) byTarget.set(key, [target])
        else list.push(target)
      }

      for (const list of byTarget.values()) {
        const head = list[0]!
        let session: Awaited<ReturnType<typeof openLogSession>> | undefined
        try {
          session = await openLogSession({ profile: head.profile, ...(head.viaProfile === undefined ? {} : { viaProfile: head.viaProfile }) })
        } catch (error) {
          const failure = toDbFailure(error)
          for (const target of list) {
            groups.push({
              profile: target.profile.name,
              ...(target.viaProfile === undefined ? {} : { via: target.viaProfile.name }),
              source: target.source.name,
              kind: target.source.kind,
              target: sourceTarget(target.source),
              matched: 0,
              scannedLines: 0,
              error: failure.message,
            })
          }
          continue
        }
        try {
          for (const target of list) {
            searched += 1
            if (remaining <= 2000) {
              truncated = true
              groups.push({
                profile: target.profile.name,
                ...(target.viaProfile === undefined ? {} : { via: target.viaProfile.name }),
                source: target.source.name,
                kind: target.source.kind,
                target: sourceTarget(target.source),
                matched: 0,
                scannedLines: 0,
                truncated: true,
                error: '输出额度已用尽（logMaxBytes），该源未检索：请缩小 sources 范围重试',
              })
              continue
            }
            const budget = Math.min(perSourceBytes, remaining)
            try {
              const sample = await session.read(target.source, {
                lines: windowLines,
                maxBytes: budget,
                timeoutMs: deps.logTimeoutMs,
                ...(since === undefined || target.source.kind !== 'journal' ? {} : { since }),
              })
              const window = tailWindow(sample.buffer, { maxLines: windowLines, maxBytes: budget })
              const sourceLines = window.lines.map(clampLine)
              const hits = filterKeyword(sourceLines, keyword)
              const body = contextLines === 0
                ? hits
                : withContext(sourceLines, keyword, contextLines)
              const kept = trimToBudget(body, budget)
              remaining -= Math.min(budget, kept.bytes)
              totalMatched += hits.length
              if (kept.truncated || window.truncated) truncated = true
              groups.push({
                profile: target.profile.name,
                ...(target.viaProfile === undefined ? {} : { via: target.viaProfile.name }),
                source: target.source.name,
                kind: target.source.kind,
                target: sample.target,
                matched: hits.length,
                scannedLines: window.scannedLines,
                ...(kept.truncated || window.truncated ? { truncated: true } : {}),
                lines: kept.lines,
              })
            } catch (error) {
              const failure = toDbFailure(error)
              groups.push({
                profile: target.profile.name,
                ...(target.viaProfile === undefined ? {} : { via: target.viaProfile.name }),
                source: target.source.name,
                kind: target.source.kind,
                target: sourceTarget(target.source),
                matched: 0,
                scannedLines: 0,
                error: failure.message,
              })
            }
          }
        } finally {
          session?.close()
        }
      }

      const elapsedMs = Date.now() - started
      deps.audit.record({
        ts: started,
        channel: 'tool',
        action: 'db_search_ssh_logs',
        status: 'ok',
        durationMs: elapsedMs,
        rowCount: totalMatched,
        detail: `sources=${searched} matched=${totalMatched}${truncated ? ' truncated' : ''}`,
      })
      return { ok: true, keyword, groups, totalMatched, searchedSources: searched, truncated, maxBytes, elapsedMs }
    },
    presentCall: (args) => ({ card: 'generic', title: `跨源检索日志${typeof args?.keyword === 'string' ? `：${args.keyword}` : ''}`, kind: 'read' }),
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
  })

  const addLogSource = defineTool({
    name: 'db_add_ssh_log_source',
    description:
      'Register (or delete) ONE log source on an existing dsh-db-manager SSH profile, so db_read_ssh_log / db_search_ssh_logs can read it. ' +
      'This is the "add it right here in the conversation" path, mirroring db_add_connection. ' +
      'It ONLY touches that profile\'s logSources array — credentials and every other field are preserved untouched, and the whole profile is ' +
      're-validated before writing (so a bad path/unit is refused instead of saved). ' +
      'kind=file needs an absolute POSIX `path`; kind=journal needs a systemd `unit` (e.g. app.service). ' +
      'This registers a read target only: it never runs anything, and the read stays a bounded tail via SFTP or journalctl.',
    parameters: {
      profile: { type: 'string', required: true, description: 'Existing SSH profile name (from db_list_ssh_logs).' },
      name: { type: 'string', required: true, description: 'New log source name, unique inside that profile (e.g. "app").' },
      kind: { type: 'string', description: 'file (default) or journal.' },
      path: { type: 'string', description: 'kind=file: absolute path on the target machine, e.g. /var/log/app/app.log.' },
      unit: { type: 'string', description: 'kind=journal: systemd unit, e.g. app.service (letters, digits and @ . _ : - only).' },
      label: { type: 'string', description: 'Optional human-readable description shown by db_list_ssh_logs.' },
      via: { type: 'string', description: 'Optional second-hop SSH profile name: the machine that actually holds this log.' },
      scope: { type: 'string', description: 'Where the profile lives: auto (default, whichever file declares it), global or workspace.' },
      delete: { type: 'boolean', description: 'When true, remove this source from the profile instead of adding it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          profile: { type: 'string' },
          source: { type: 'string' },
          action: { type: 'string', enum: ['created', 'replaced', 'deleted'] },
          scope: { type: 'string', enum: ['global', 'workspace'] },
          path: { type: 'string' },
          warning: { type: 'string' },
          failureMessage: { type: 'string' },
          failureHint: { type: 'string' },
        },
      } as const,
      render: (_args, value) => {
        if (value.ok === false) {
          return [{ type: 'text', text: `登记日志源失败：${value.failureMessage ?? '未知原因'}${value.failureHint === undefined ? '' : `\n原因：${value.failureHint}`}` }]
        }
        const verb = value.action === 'deleted' ? '已删除' : value.action === 'replaced' ? '已更新' : '已新增'
        const lines = [`${verb}日志源 ${value.profile}/${value.source}（${value.scope}）${value.path === undefined ? '' : ` → ${value.path}`}`]
        if (value.warning !== undefined) lines.push(`提示：${value.warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const started = Date.now()
      const record = (args ?? {}) as Record<string, unknown>
      const profileName = typeof record.profile === 'string' ? record.profile.trim() : ''
      const sourceName = typeof record.name === 'string' ? record.name.trim() : ''
      const scopeInput = typeof record.scope === 'string' ? record.scope : 'auto'
      const scope: 'auto' | 'global' | 'workspace' = scopeInput === 'global' || scopeInput === 'workspace' ? scopeInput : 'auto'
      const deleting = record.delete === true

      const fail = (message: string, hint?: string) => {
        deps.audit.record({
          ts: started,
          channel: 'tool',
          action: 'db_add_ssh_log_source',
          status: 'error',
          ...(profileName.length === 0 ? {} : { connection: profileName }),
          durationMs: Date.now() - started,
          detail: `${sourceName || '(无源)'} ${message}`,
        })
        return { ok: false, profile: profileName, source: sourceName, failureMessage: message, ...(hint === undefined ? {} : { failureHint: hint }) }
      }

      if (profileName.length === 0) return fail('缺少 profile 参数', '先调用 db_list_ssh_logs 查看已有 SSH 配置')
      if (sourceName.length === 0) return fail('缺少 name 参数', '传入一个日志源名，例如 "app"')

      const source: Record<string, unknown> = { name: sourceName }
      if (!deleting) {
        const kind = typeof record.kind === 'string' && record.kind.length > 0 ? record.kind : 'file'
        if (kind !== 'file' && kind !== 'journal') return fail('kind 只能是 file 或 journal')
        source.kind = kind
        if (typeof record.path === 'string' && record.path.trim().length > 0) source.path = record.path.trim()
        if (typeof record.unit === 'string' && record.unit.trim().length > 0) source.unit = record.unit.trim()
        if (typeof record.label === 'string' && record.label.trim().length > 0) source.label = record.label.trim()
        if (typeof record.via === 'string' && record.via.trim().length > 0) source.via = record.via.trim()
      }

      const cwd = resolveWorkspaceCwd(exec)
      const outcome = saveLogSourceInto(
        deps.store,
        { scope, ...(cwd === undefined ? {} : { cwd }) },
        { profileName, source: source as unknown as SshLogSourceSpec, delete: deleting },
      )
      if (!outcome.ok) {
        return fail(outcome.error ?? '写入配置失败', outcome.warnings?.join('；'))
      }
      deps.audit.record({
        ts: started,
        channel: 'tool',
        action: 'db_add_ssh_log_source',
        status: 'ok',
        connection: profileName,
        durationMs: Date.now() - started,
        detail: `${sourceName} ${outcome.action ?? 'created'} scope=${outcome.scope ?? '?'}`,
      })
      return {
        ok: true,
        profile: profileName,
        source: sourceName,
        ...(outcome.action === undefined ? {} : { action: outcome.action }),
        ...(outcome.scope === undefined ? {} : { scope: outcome.scope }),
        ...(outcome.path === undefined ? {} : { path: outcome.path }),
        ...(outcome.warning === undefined ? {} : { warning: outcome.warning }),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `登记日志源${typeof args?.name === 'string' ? `：${args.name}` : ''}`, kind: 'execute' }),
    isConcurrencySafe: () => false,
    timeoutMs: 10_000,
  })

  return [listLogs, readLog, searchLogs, addLogSource]
}

/** Trim context lines so one source cannot spend the whole multi-source quota. */
function trimToBudget(lines: string[], budgetBytes: number): { lines: string[]; bytes: number; truncated: boolean } {
  const kept: string[] = []
  let bytes = 0
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + size > budgetBytes) return { lines: kept, bytes, truncated: true }
    kept.push(line)
    bytes += size
  }
  return { lines: kept, bytes, truncated: false }
}

/** Matching lines plus surrounding context, matches marked with `▶`. */
function withContext(lines: readonly string[], keyword: string, contextLines: number): string[] {
  const needle = keyword.toLowerCase()
  const isMatch = lines.map((line) => line.toLowerCase().includes(needle))
  const keep = new Set<number>()
  isMatch.forEach((match, index) => {
    if (!match) return
    for (let offset = -contextLines; offset <= contextLines; offset += 1) {
      const position = index + offset
      if (position >= 0 && position < lines.length) keep.add(position)
    }
  })
  const out: string[] = []
  let previous = -2
  for (const position of [...keep].sort((a, b) => a - b)) {
    if (position !== previous + 1) out.push('  …')
    out.push(`${isMatch[position] === true ? '▶ ' : '  '}${lines[position]!}`)
    previous = position
  }
  return out
}

function toResultPayload(result: SshLogReadResult): Record<string, unknown> {
  return {
    profile: result.profile,
    source: result.source,
    kind: result.kind,
    target: result.target,
    ...(result.via === undefined ? {} : { via: result.via }),
    lines: result.lines,
    lineCount: result.lineCount,
    scannedLines: result.scannedLines,
    ...(result.matched === undefined ? {} : { matched: result.matched }),
    truncated: result.truncated,
    windowBytes: result.windowBytes,
    maxBytes: result.maxBytes,
    elapsedMs: result.elapsedMs,
  }
}
