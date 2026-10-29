/** Data tools (M3/M4): read-only query with truncation, guarded execution with confirm tokens and shadow backup. */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { classifySql, injectReadLimit } from '../safety/classify.js'
import { issueConfirmToken, verifyConfirmToken } from '../safety/confirm.js'
import type { HostApprovalOutcome } from '../safety/approval.js'
import { toDbFailure } from '../db/errors.js'
import { planRowBackup, type RowBackupPlan } from '../db/backup.js'
import { resolveTarget, quoteIdentifier } from './resolve.js'
import { resolveSessionInfo } from './workspace.js'
import { openPoolFor } from './metadata.js'
import { toPlainRows, truncateRows, type JsonRow } from '../shared/truncate.js'
import type { ToolDeps } from './index.js'
import type { AuditEntry } from '../audit/log.js'

function clampLimit(value: unknown, maxRows: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return Math.min(Math.floor(value), maxRows)
  return Math.min(50, maxRows)
}

/**
 * Read-path row cap (audit N4, 2nd round). A statement that carries its own
 * LIMIT with a huge value would otherwise be fully buffered by the driver
 * before the host truncates rows. When the AST-derived limit exceeds the
 * requested cap, wrap the statement in a derived table with the smaller cap —
 * the same technique `injectReadLimit` uses for the no-LIMIT case.
 *
 * Exported for tests. `limit` comes from the AST (null = no LIMIT clause,
 * NaN = LIMIT present but unreadable → left untouched).
 */
export function enforceReadLimit(statement: string, limit: number | null | undefined, cap: number): { text: string; injected: boolean } {
  const trimmed = statement.replace(/;\s*$/, '')
  if (limit === null) {
    // AST-derived text has no trailing comments, so a direct append is safe.
    return { text: `${trimmed} LIMIT ${cap}`, injected: true }
  }
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > cap) {
    return { text: `SELECT * FROM (${trimmed}) AS __dbm_l LIMIT ${cap}`, injected: true }
  }
  return { text: statement, injected: false }
}

/**
 * v0.10 backup policy decision. Returns true iff the statement should go
 * through the row-level shadow-backup path.
 *
 *   - `withBackup === true`  → force backup on
 *   - `withBackup === false` → force backup off (overrides policy default)
 *   - `withBackup === undefined` → defer to `backupDefault`:
 *       - 'always'    → on
 *       - 'opt-in'    → off
 *       - 'small-only' → on only when `affectedEstimate !== undefined &&
 *         affectedEstimate <= backupSmallThreshold`
 *
 * Exported so the verify.mjs runner can exercise the matrix without spinning
 * up a real database.
 */
export function shouldBackup(opts: {
  withBackup: boolean | undefined
  backupDefault: 'always' | 'small-only' | 'opt-in'
  backupSmallThreshold: number
  affectedEstimate: number | undefined
}): boolean {
  if (opts.withBackup === true) return true
  if (opts.withBackup === false) return false
  switch (opts.backupDefault) {
    case 'always':
      return true
    case 'opt-in':
      return false
    case 'small-only':
      return opts.affectedEstimate !== undefined && opts.affectedEstimate <= opts.backupSmallThreshold
  }
}

/**
 * Ask the host approval service for an explicit human decision. Never resolves
 * to 'allowed-once' on error — failures degrade to 'unavailable' so the caller
 * falls back to the token loop, and a human denial always propagates.
 */
async function requestHostApproval(deps: ToolDeps, exec: unknown, reason: string): Promise<HostApprovalOutcome> {
  if (deps.requestApproval === undefined) return 'unavailable'
  const context = (exec ?? {}) as { agent?: unknown; callId?: unknown; signal?: unknown }
  try {
    return await deps.requestApproval({
      agent: context.agent,
      toolName: 'db_execute',
      ...(typeof context.callId === 'string' && context.callId.length > 0 ? { callId: context.callId } : {}),
      reason,
      ...(context.signal instanceof AbortSignal ? { signal: context.signal } : {}),
    })
  } catch {
    return 'unavailable'
  }
}

export function buildDataTools(deps: ToolDeps): unknown[] {
  const dbQuery = defineTool({
    name: 'db_query',
    description:
      'Run ONE read-only statement (SELECT/SHOW/DESC/EXPLAIN) through a dsh-db-manager connection. The safety gateway rejects anything ' +
      'non-read-only; EXPLAIN passes only when its inner statement is also read-only. A missing LIMIT is injected automatically ' +
      '(default 50); results are truncated to caps and flagged with `truncated`. Multi-statement input is refused. Use db_execute for writes.',
    parameters: {
      connection: { type: 'string', description: 'Connection name from db_list_connections. Omit for the default connection.' },
      database: { type: 'string', description: 'Database (schema) to run against. Omit for the connection default database.' },
      sql: { type: 'string', required: true, description: 'A single read-only statement.' },
      limit: { type: 'integer', description: 'Row cap injected when the statement has no LIMIT (1..200).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          columns: { type: 'array', required: true, items: { type: 'string' } },
          rows: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          rowCount: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          totalEstimate: { type: 'integer' },
          durationMs: { type: 'integer', required: true },
          failureMessage: { type: 'string' },
          failureHint: { type: 'string' },
        },
      } as const,
      render: (_args, value) => {
        if (value.failureMessage !== undefined) return [{ type: 'text', text: `查询被拒绝：${value.failureMessage}${value.failureHint === undefined ? '' : `\n建议：${value.failureHint}`}` }]
        const lines = [`返回 ${value.rowCount} 行${value.truncated ? '（已截断）' : ''}，耗时 ${value.durationMs}ms${value.totalEstimate === undefined ? '' : `，全量约 ${value.totalEstimate} 行`}`]
        for (const row of value.rows.slice(0, 20)) {
          const record = row as Record<string, unknown>
          lines.push(Object.entries(record).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' | '))
        }
        if (value.rows.length > 20) lines.push(`…（其余 ${value.rows.length - 20} 行见结构化结果）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const started = Date.now()
      const session = resolveSessionInfo(exec)
      const record = (args ?? {}) as { connection?: unknown; database?: unknown; sql?: unknown; limit?: unknown }
      const wanted = typeof record.connection === 'string' ? record.connection : undefined
      const database = typeof record.database === 'string' && record.database.length > 0 ? record.database : undefined
      const sql = typeof record.sql === 'string' ? record.sql : ''
      const auditBase: Omit<AuditEntry, 'status'> = { ts: started, channel: 'tool', action: 'db_query', connection: wanted, database, sql }
      const base = { columns: [] as string[], rows: [] as JsonRow[], rowCount: 0, truncated: false, durationMs: Date.now() - started }
      const fail = (failureMessage: string, failureHint?: string) => {
        deps.audit.record({ ...auditBase, status: 'error', durationMs: Date.now() - started, detail: failureMessage })
        return { ...base, failureMessage, ...(failureHint === undefined ? {} : { failureHint }) }
      }
      if (sql.trim().length === 0) {
        return fail('缺少 sql 参数')
      }
      const opened = await openPoolFor(deps, session, wanted, database, 'db_query')
      if (opened.failure !== undefined || opened.pool === undefined) {
        const failure = opened.failure!
        return fail(failure.message, failure.hint)
      }
      const pool = opened.pool
      auditBase.connection = pool.connectionName
      auditBase.database = pool.database
      const classification = classifySql(sql, pool.dialect)
      if (classification.statements.length !== 1) {
        return fail('db_query 每次只接受一条语句', '请分次执行，或使用一条合并的查询')
      }
      const stmt = classification.statements[0]!
      auditBase.kind = stmt.kind
      if (stmt.kind !== 'read' || stmt.dangerous) {
        return fail(
          stmt.reason ?? (stmt.kind === 'unknown' ? '无法可靠识别该语句，只读通道拒绝执行' : `只读通道拒绝了 ${stmt.kind === 'write' ? '写' : 'DDL'} 语句`),
          stmt.kind === 'write' || stmt.kind === 'ddl' ? '写操作请让模型调用 db_execute（读写模式连接，高危语句需确认）' : '请检查语句',
        )
      }
      // Audit N10 (2nd round) / 开发规范 §4.2: round-trip the NORMALIZED text
      // and require the read verdict to survive. The text we actually execute
      // is always the caller's original statement — the parser's regeneration
      // is dialect-lossy (it emits MySQL backticks even for `type: postgresql`,
      // which PostgreSQL rejects), so it is a cross-check input only.
      if (stmt.reliable) {
        const roundTrip = classifySql(stmt.normalized ?? stmt.statement, pool.dialect)
        const reStmt = roundTrip.statements.length === 1 ? roundTrip.statements[0] : undefined
        if (!roundTrip.reliable || reStmt === undefined || reStmt.kind !== 'read' || reStmt.dangerous || reStmt.blocked) {
          return fail('语句规范化后未通过只读复核（规范化文本不再是一个明确的只读查询）', '请简化语句后重试')
        }
      }
      let text = stmt.statement
      let injectedLimit = false
      const cap = clampLimit(record.limit, deps.maxRows)
      if (stmt.reliable) {
        const enforced = enforceReadLimit(stmt.statement, stmt.limit, cap)
        text = enforced.text
        injectedLimit = enforced.injected
      } else if (stmt.limit === null) {
        // Fallback text keeps original comments — appending LIMIT could be
        // swallowed by a trailing line comment, so wrap instead.
        text = injectReadLimit(text, cap)
        injectedLimit = true
      }
      try {
        const rawRows = await pool.run(text)
        const plain = toPlainRows(Array.isArray(rawRows) ? (rawRows as unknown[]) : [])
        const shaped = truncateRows(plain.rows, deps.maxRows, 1_000_000)
        const durationMs = Date.now() - started
        let totalEstimate: number | undefined
        // Audit H5 / M9: the estimate splices the statement text into a fresh
        // SELECT COUNT(*), which is safe only when it came from a reliable AST.
        // Prefer the parser-regenerated (canonical) text here — it carries no
        // comments that could swallow the wrapping alias — and fall back to the
        // original statement. The regex fallback (unparsable input) can keep
        // comments / multi-statement fragments, so we refuse to estimate on that
        // path rather than splice untrusted text. Estimation is best-effort.
        if (shaped.truncated && injectedLimit && stmt.reliable) {
          try {
            const countSource = (stmt.normalized ?? stmt.statement).replace(/;\s*$/, '')
            const countRows = (await pool.run(`SELECT COUNT(*) AS __dbm_count FROM (${countSource}) AS __dbm_count`)) as Array<Record<string, unknown>>
            const estimate = countRows[0]?.['__dbm_count']
            const numeric = typeof estimate === 'number' ? estimate : typeof estimate === 'string' && /^\d+$/.test(estimate) ? Number.parseInt(estimate, 10) : undefined
            if (numeric !== undefined) totalEstimate = numeric
          } catch {
            /* best-effort estimate */
          }
        }
        deps.audit.record({ ...auditBase, status: 'ok', durationMs, rowCount: shaped.rowCount })
        return {
          columns: plain.columns,
          rows: shaped.rows,
          rowCount: shaped.rowCount,
          truncated: shaped.truncated,
          durationMs,
          ...(totalEstimate === undefined ? {} : { totalEstimate }),
        }
      } catch (error) {
        const failure = toDbFailure(error)
        return fail(failure.message, failure.hint)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `查询数据库（${typeof (args as { sql?: string })?.sql === 'string' ? (args as { sql: string }).sql.slice(0, 40) : '?'}…）`, kind: 'read' }),
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
  })

  const dbExecute = defineTool({
    name: 'db_execute',
    description:
      'Execute ONE write/DDL statement (INSERT/UPDATE/DELETE/CREATE/…) through a dsh-db-manager READWRITE connection. ' +
      'Read-only connections are refused. UPDATE/DELETE are shadow-backed up first: the affected rows are copied into a ' +
      '__dbm_backup_* table on the same server and the backup table name is returned; if the affected-row count exceeds ' +
      'backupMaxRows, or the affected rows cannot be determined (REPLACE, multi-table JOIN, unparsable SQL), the statement is ' +
      'refused once with guidance to back up manually — retry with backupAck: true to skip the plugin backup. ' +
      '\n\nBackup policy (v0.10, backupDefault in cordis patch): ' +
      '- "always": every backable write goes through a backup table. ' +
      '- "small-only" (default): only when affectedEstimate <= backupSmallThreshold. ' +
      '- "opt-in": never unless `withBackup: true` is passed. ' +
      '`withBackup: true|false` overrides the policy for this call. ' +
      'Dangerous statements ' +
      '(DROP/TRUNCATE/ALTER/RENAME, UPDATE/DELETE without WHERE, unparsable SQL) are refused once and gated: when the host approval ' +
      'service is available the user is prompted to approve before execution and a denial returns no token; otherwise a confirmToken ' +
      'bound to this exact statement is returned — explain the risk to the user, and retry with the SAME statement plus confirmToken ' +
      'ONLY after the user explicitly agrees. Never fabricate a token. Read statements belong in db_query.',
    parameters: {
      connection: { type: 'string', description: 'Connection name from db_list_connections. Omit for the default connection.' },
      database: { type: 'string', description: 'Database (schema) to run against. Omit for the connection default database.' },
      sql: { type: 'string', required: true, description: 'A single write or DDL statement.' },
      confirmToken: { type: 'string', description: 'Confirmation token returned by the previous refusal; required for dangerous statements after the user agrees.' },
      withBackup: {
        type: 'boolean',
        description:
          'v0.10 — explicit override of the backup policy. true forces backup on, false forces backup off. ' +
          'Omit to defer to backupDefault in cordis patch.',
      },
      backupAck: {
        type: 'boolean',
        description:
          'Set true ONLY after the user acknowledged one of: the affected-row count exceeded backupMaxRows, or the plugin cannot ' +
          'back up this statement (REPLACE/multi-table/unparsable). Skips the plugin shadow backup for this call.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          connection: { type: 'string', required: true },
          refused: { type: 'boolean', required: true },
          reason: { type: 'string' },
          riskExplanation: { type: 'string' },
          confirmToken: { type: 'string' },
          expiresAt: { type: 'integer' },
          affectedRows: { type: 'integer' },
          insertId: { type: 'integer' },
          backupTable: { type: 'string' },
          backupRows: { type: 'integer' },
          backupSkipped: { type: 'boolean' },
          durationMs: { type: 'integer', required: true },
          failureMessage: { type: 'string' },
          failureHint: { type: 'string' },
        },
      } as const,
      render: (_args, value) => {
        if (value.refused) {
          const lines = [`已拒绝（${value.reason ?? 'unknown'}）：${value.riskExplanation ?? ''}`]
          if (value.confirmToken !== undefined) lines.push('已生成确认令牌。向用户说明风险，用户明确同意后携带 confirmToken 重试同一语句。')
          if (value.failureHint !== undefined) lines.push(`建议：${value.failureHint}`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (value.ok) {
          const backup =
            value.backupTable === undefined
              ? value.backupSkipped === true
                ? '；⚠ 本语句未做行级备份'
                : ''
              : `；已备份原数据 ${value.backupRows ?? '?'} 行到 ${value.backupTable}`
          return [{ type: 'text', text: `执行成功：影响 ${value.affectedRows ?? 0} 行${value.insertId === undefined ? '' : `，insertId=${value.insertId}`}（${value.durationMs ?? '?'}ms）${backup}` }]
        }
        return [{ type: 'text', text: `执行失败：${value.failureMessage ?? '未知错误'}` }]
      },
    },
    async execute(args, exec) {
      const started = Date.now()
      const session = resolveSessionInfo(exec)
      const record = (args ?? {}) as { connection?: unknown; database?: unknown; sql?: unknown; confirmToken?: unknown; withBackup?: unknown; backupAck?: unknown }
      const wanted = typeof record.connection === 'string' ? record.connection : undefined
      const database = typeof record.database === 'string' && record.database.length > 0 ? record.database : undefined
      const sql = typeof record.sql === 'string' ? record.sql : ''
      const confirmToken = typeof record.confirmToken === 'string' ? record.confirmToken : undefined
      // v0.10: withBackup is tri-state — true (force on), false (force off),
      // undefined (defer to backupDefault policy).
      const withBackup = record.withBackup === true ? true : record.withBackup === false ? false : undefined
      const backupAck = record.backupAck === true
      const auditBase: Omit<AuditEntry, 'status'> = { ts: started, channel: 'tool', action: 'db_execute', connection: wanted, database, sql }
      const refuse = (reason: string, riskExplanation: string, extra?: { confirmToken?: string; expiresAt?: number }) => {
        const status: AuditEntry['status'] = reason === 'dangerous' ? 'refused-dangerous' : ['read-only-mode', 'multi-statement', 'read-statement', 'backup-infeasible', 'backup-too-large', 'blocked-statement', 'user-rejected', 'unverifiable'].includes(reason) ? 'refused' : 'error'
        deps.audit.record({
          ...auditBase,
          status,
          durationMs: Date.now() - started,
          detail: riskExplanation,
        })
        return {
          ok: false,
          connection: wanted ?? '(default)',
          refused: true,
          reason,
          riskExplanation,
          durationMs: Date.now() - started,
          ...(extra?.confirmToken === undefined ? {} : { confirmToken: extra.confirmToken }),
          ...(extra?.expiresAt === undefined ? {} : { expiresAt: extra.expiresAt }),
        }
      }
      if (sql.trim().length === 0) return refuse('empty-sql', '缺少 sql 参数')
      const target = resolveTarget(deps.store, session.cwd, wanted)
      if (target.failure !== undefined || target.spec === undefined) {
        const failure = target.failure ?? { kind: 'config', message: '连接不存在' }
        return { ...refuse('config', failure.message), ...(failure.hint === undefined ? {} : { failureHint: failure.hint }) }
      }
      const spec = target.spec
      auditBase.connection = spec.name
      if (spec.mode !== 'readwrite') {
        return refuse('read-only-mode', `连接 "${spec.name}" 为只读模式，所有写操作被拒绝（如需写入请在连接配置中改为 readwrite）`)
      }
      const opened = await openPoolFor(deps, session, wanted, database, 'db_execute')
      if (opened.failure !== undefined || opened.pool === undefined) {
        const failure = opened.failure!
        return { ...refuse('config', failure.message), ...(failure.hint === undefined ? {} : { failureHint: failure.hint }) }
      }
      const pool = opened.pool
      auditBase.database = pool.database
      const classification = classifySql(sql, pool.dialect)
      if (classification.statements.length !== 1) {
        return refuse('multi-statement', '每次只接受一条语句；请拆分为多次执行')
      }
      const stmt = classification.statements[0]!
      // Audit N10 (2nd round) / 开发规范 §4.2: re-classify the NORMALIZED text
      // and require the verdict to survive the round-trip. The executed and
      // token-signed statement stays the caller's original text — the parser's
      // regeneration is dialect-lossy (MySQL backticks even for
      // `type: postgresql`, which PostgreSQL rejects) and must not be executed.
      // A canonical text that flips kind, gains a blocked shape, or loses the
      // dangerous marker is refused; one that GAINS danger adopts the stricter
      // verdict (only the verdict — the text is not replaced).
      let stmtVerified = stmt
      if (stmt.reliable) {
        const roundTrip = classifySql(stmt.normalized ?? stmt.statement, pool.dialect)
        const reStmt = roundTrip.statements.length === 1 ? roundTrip.statements[0] : undefined
        if (!roundTrip.reliable || reStmt === undefined) {
          return refuse('unverifiable', '语句规范化复核失败（规范化文本无法重新解析为单条语句），已拒绝执行')
        }
        if (reStmt.blocked) {
          return refuse('blocked-statement', reStmt.reason ?? '该语句禁止通过本插件执行')
        }
        if (reStmt.kind !== stmt.kind) {
          return refuse('unverifiable', `语句规范化复核与原始分类不一致（${stmt.kind} → ${reStmt.kind}），可能被解析器改写语义，已拒绝执行`)
        }
        if (reStmt.dangerous && !stmt.dangerous) {
          stmtVerified = { ...stmt, dangerous: true, ...(reStmt.reason === undefined ? {} : { reason: reStmt.reason }) }
        } else if (!reStmt.dangerous && stmt.dangerous) {
          return refuse('unverifiable', '语句规范化复核后危险标记消失（可能被解析器改写语义），已拒绝执行')
        }
      }
      const effStmt = stmtVerified
      auditBase.kind = effStmt.kind
      if (effStmt.kind === 'read') {
        return refuse('read-statement', '只读语句请使用 db_query')
      }
      if (effStmt.blocked) {
        return refuse('blocked-statement', effStmt.reason ?? '该语句禁止通过本插件执行')
      }
      // ── Row-level shadow backup (用户需求：UPDATE/DELETE 先备份受影响行) ──
      // INSERT 需要的行不存在，无需备份；REPLACE/多表/解析失败等无法可靠定位
      // 受影响行的情况会拒绝并提示用户自行备份（backupAck 确认后可跳过）。
      //
      // v0.10: the policy gate `shouldBackup()` decides whether to even plan
      // a backup. For 'opt-in' without an explicit withBackup this whole
      // branch is skipped — no countSql, no backup table, no overhead.
      let backupPlan: RowBackupPlan | undefined
      let backupSkipped = false
      let affectedEstimate: number | undefined
      let backupWanted = false
      if (deps.backupEnabled) {
        const decision = planRowBackup(effStmt.ast, pool.database, pool.dialect)
        if (decision.kind === 'infeasible') {
          // Infeasible plans are decided up front — the caller must already
          // have backupAck:true to proceed without backup, otherwise we
          // refuse with guidance. (Policy gate doesn't apply: even an
          // opt-in caller must opt in OR explicitly acknowledge infeasibility.)
          if (!backupAck) {
            return refuse('backup-infeasible', `${decision.reason}。${decision.hint ?? ''}${decision.suggestSql === undefined ? '' : `\n自行备份参考：\n${decision.suggestSql}`}`)
          }
          backupSkipped = true
        } else if (decision.kind === 'ready') {
          // Estimate the affected row count first so the 'small-only' policy
          // can decide without spending the rest of the backup budget.
          try {
            const countRows = (await pool.run(decision.plan.countSql)) as Array<Record<string, unknown>>
            const value = countRows[0]?.['__dbm_c']
            affectedEstimate = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number.parseInt(value, 10) : undefined
          } catch (error) {
            if (!backupAck) {
              const failure = toDbFailure(error)
              return refuse('backup-infeasible', `无法统计受影响行数（${failure.message}）。已自行统计并备份可携带 backupAck: true 重试跳过插件备份`)
            }
            backupSkipped = true
          }
          backupWanted = shouldBackup({
            withBackup,
            backupDefault: deps.backupDefault,
            backupSmallThreshold: deps.backupSmallThreshold,
            affectedEstimate,
          })
          if (!backupWanted) {
            // Policy gate says no backup. Treat as backupSkipped but record
            // the reason so the audit + user response make it clear why.
            backupSkipped = true
          } else if (affectedEstimate === 0) {
            backupPlan = undefined // nothing will change — no backup needed
          } else if (affectedEstimate !== undefined && affectedEstimate > deps.backupMaxRows) {
            if (!backupAck) {
              return refuse(
                'backup-infeasible',
                `该语句将影响约 ${affectedEstimate} 行，超过自动备份上限（${deps.backupMaxRows} 行）。为防误操作无法找回，请先自行备份，例如：\n${decision.plan.suggestSql}\n确认已自行备份（或明确接受不可找回）后，携带 backupAck: true 重试`,
              )
            }
            backupSkipped = true
          } else if (affectedEstimate !== undefined) {
            backupPlan = decision.plan
          }
        }
      }
      let confirmed = false
      let confirmedVia: 'host-approval' | 'confirm-token' | undefined
      if (effStmt.dangerous) {
        const verdict = verifyConfirmToken(confirmToken, spec.name, effStmt.statement)
        if (verdict.ok) {
          confirmed = true
          confirmedVia = 'confirm-token'
        } else {
          const backupNote = backupPlan === undefined ? (backupSkipped ? '（注意：本语句不会由插件自动备份）' : '') : `（执行时将先把受影响的 ${affectedEstimate ?? '?'} 行备份到 ${backupPlan.backupName}）`
          const riskSummary = `${effStmt.reason ?? '高危语句'}；连接 ${spec.name}；语句：${effStmt.statement}${backupNote}`
          const approval = await requestHostApproval(deps, exec, riskSummary)
          if (approval === 'allowed-once') {
            confirmed = true
            confirmedVia = 'host-approval'
          } else if (approval === 'rejected' || approval === 'cancelled') {
            // A human explicitly denied: refuse WITHOUT a token so the denial
            // cannot be bypassed by a self-issued retry — a later attempt has
            // to go through the approval prompt again.
            return refuse('user-rejected', `用户已拒绝执行该高危语句，未执行：${effStmt.reason ?? '高危操作'}`)
          } else {
            // Approval channel unavailable (service absent or unattended):
            // fall back to the PRD FR-9 token loop (documented residual risk).
            const issued = issueConfirmToken(spec.name, effStmt.statement)
            return refuse('dangerous', `${effStmt.reason ?? '高危语句'}（宿主审批通道不可用，退回确认令牌模式）。向用户说明风险，用户明确同意后携带 confirmToken 重试同一语句。确认后将执行：${effStmt.statement.slice(0, 200)}${backupNote}`, issued)
          }
        }
      }
      // M6: backup table is created OUTSIDE the transaction (MySQL InnoDB's
      // DDL implicit-commit makes in-transaction CREATE unsafe). The backup
      // INSERT/verify and the user statement then run inside a transaction
      // whose rollback drops the backup rows AND undoes the user change.
      // On any failure the outer catch drops the leftover backup table.
      interface TxError { stage: 'backup-insert' | 'backup-verify' | 'user-stmt' | 'unknown'; message: string }
      let txError: TxError | null = null
      let userStmtResult: unknown
      try {
        if (backupPlan !== undefined) {
          // Audit H4: each backup step is generated from the AST but executed
          // as raw SQL by the driver. Re-parse each segment and refuse to
          // execute it if its kind doesn't match the expected step — this
          // catches any future regression in planRowBackup that might emit
          // an unexpected statement (and so protects the write path from
          // splicing untrusted SQL into the driver's execute()).
          const check = (label: 'createSql' | 'insertSql' | 'verifySql' | 'userSql', sql: string, expected: 'ddl' | 'write' | 'read'): string | null => {
            const c = classifySql(sql, pool.dialect)
            const stmt0 = c.statements[0]
            if (c.statements.length !== 1 || !c.reliable || stmt0 === undefined || stmt0.kind !== expected) {
              return `${label} 异常：expected ${expected}, got ${stmt0?.kind ?? 'none'} (reliable=${c.reliable}, count=${c.statements.length})`
            }
            return null
          }
          const err1 = check('createSql', backupPlan.createSql, 'ddl')
          if (err1 !== null) {
            deps.audit.record({ ...auditBase, status: 'error', durationMs: Date.now() - started, detail: `backup ${err1}; statement: ${backupPlan.createSql.slice(0, 200)}` })
            return { ok: false, connection: pool.connectionName, refused: false, durationMs: Date.now() - started, failureMessage: `备份计划异常（${err1}），已中止执行` }
          }
          await pool.run(backupPlan.createSql)
          deps.audit.record({ ...auditBase, status: 'ok', durationMs: Date.now() - started, detail: `backup-create ok ${backupPlan.backupName}` })
          try {
            await pool.withTransaction(async (tx) => {
              const runStage = (stage: 'backup-insert' | 'backup-verify' | 'user-stmt', message: string): never => {
                txError = { stage, message }
                throw new Error(message)
              }
              const err2 = check('insertSql', backupPlan.insertSql, 'write')
              if (err2 !== null) runStage('backup-insert', `备份计划异常（${err2}）`)
              await tx.run(backupPlan.insertSql)
              const err3 = check('verifySql', backupPlan.verifySql, 'read')
              if (err3 !== null) runStage('backup-verify', `备份计划异常（${err3}）`)
              const verifyRows = (await tx.run(backupPlan.verifySql)) as Array<Record<string, unknown>>
              const backupCount = Number(verifyRows[0]?.['__dbm_c'] ?? Number.NaN)
              if (!Number.isFinite(backupCount) || backupCount !== affectedEstimate) {
                runStage('backup-verify', `备份校验失败（预计 ${affectedEstimate} 行，实际备份 ${backupCount} 行）`)
              }
              const errUser = check('userSql', effStmt.statement, 'write')
              if (errUser !== null) runStage('user-stmt', `user SQL 异常（${errUser}）`)
              userStmtResult = await tx.run(effStmt.statement)
            })
          } catch (error) {
            // Transaction has already rolled back; we still need to drop the
            // backup table that was created outside it.
            await pool.run(`DROP TABLE IF EXISTS ${quoteIdentifier(pool.dialect, backupPlan.backupName)}`).catch(() => undefined)
            // ts narrows txError to never inside the catch block; assert to
            // its declared shape so the audit message stays informative.
            const captured = txError as { stage: string; message: string } | null
            const stage = captured?.stage ?? 'unknown'
            const msg = captured?.message ?? (error instanceof Error ? error.message : '事务执行失败')
            deps.audit.record({ ...auditBase, status: 'error', durationMs: Date.now() - started, detail: `tx-rollback stage=${stage}: ${msg}` })
            return { ok: false, connection: pool.connectionName, refused: false, durationMs: Date.now() - started, failureMessage: `${msg}（事务已回滚，备份表已清理）` }
          }
        } else {
          // No backup plan (INSERT / DDL without backup table): just run the
          // user statement on the outer pool. A future iteration could wrap
          // this in a transaction too for symmetry.
          userStmtResult = await pool.run(effStmt.statement)
        }
        const result: unknown = userStmtResult
        const header = (Array.isArray(result) ? result[0] : result) as { affectedRows?: unknown; insertId?: unknown } | undefined
        const affectedRows = typeof header?.affectedRows === 'number' ? header.affectedRows : 0
        const insertId = typeof header?.insertId === 'number' && header.insertId > 0 ? header.insertId : undefined
        deps.audit.record({
          ...auditBase,
          status: 'ok',
          durationMs: Date.now() - started,
          rowCount: affectedRows,
          confirmed,
          ...(confirmedVia === undefined ? {} : { approval: confirmedVia }),
          ...(backupPlan === undefined ? (backupSkipped ? { detail: '备份跳过（backupAck）' } : {}) : { detail: `backup -> ${backupPlan.backupName} (${affectedEstimate} rows) in tx, committed` }),
        })
        return {
          ok: true,
          connection: pool.connectionName,
          refused: false,
          affectedRows,
          ...(insertId === undefined ? {} : { insertId }),
          ...(backupPlan === undefined ? (backupSkipped ? { backupSkipped: true } : {}) : { backupTable: backupPlan.backupName, backupRows: affectedEstimate }),
          durationMs: Date.now() - started,
        }
      } catch (error) {
        const failure = toDbFailure(error)
        deps.audit.record({ ...auditBase, status: 'error', durationMs: Date.now() - started, detail: failure.message, confirmed, ...(confirmedVia === undefined ? {} : { approval: confirmedVia }) })
        return { ok: false, connection: pool.connectionName, refused: false, durationMs: Date.now() - started, failureMessage: failure.message, ...(failure.hint === undefined ? {} : { failureHint: failure.hint }) }
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `执行 SQL（${typeof (args as { sql?: string })?.sql === 'string' ? (args as { sql: string }).sql.slice(0, 40) : '?'}…）`, kind: 'execute' }),
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
  })

  return [dbQuery, dbExecute]
}
