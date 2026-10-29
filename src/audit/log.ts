/**
 * Audit trail (FR-11): every tool call and configuration mutation is appended
 * to a day-rolling JSONL file under <DSH_HOME>/db-manager/audit/. Entries
 * carry statement metadata only — never result rows, never credentials. Files
 * older than 30 days are pruned lazily on write.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface AuditEntry {
  ts: number
  channel: 'tool' | 'rpc'
  action: string
  status: 'ok' | 'error' | 'refused' | 'refused-dangerous'
  connection?: string
  database?: string
  /** Truncated, credential-stripped statement text. */
  sql?: string
  kind?: string
  durationMs?: number
  rowCount?: number
  confirmed?: boolean
  /** How the confirmation was obtained: 'host-approval' | 'confirm-token'. */
  approval?: string
  detail?: string
}

const SQL_MAX_CHARS = 2000
const RETENTION_DAYS = 30
const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

function dayStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Strip password-looking fragments and clamp length before persistence. */
export function sanitizeSql(sql: string): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  const clipped = oneLine.length > SQL_MAX_CHARS ? `${oneLine.slice(0, SQL_MAX_CHARS)}…(truncated)` : oneLine
  return clipped
    .replace(/\$ENV:[A-Za-z_][A-Za-z0-9_]*/g, '$ENV:***')
    .replace(/enc:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/g, 'enc:v1:***')
    // Literal credentials embedded in DDL/DCL statements (audit M3): a full SQL
    // text in the audit file must not carry plaintext passwords either.
    // Three quote conventions (single / double / backtick) and the most common
    // password-bearing DCL shapes across MySQL, PostgreSQL, SQLite.
    .replace(/IDENTIFIED\s+BY\s+'[^']*'/gi, "IDENTIFIED BY '***'")
    .replace(/IDENTIFIED\s+BY\s+"[^"]*"/gi, 'IDENTIFIED BY "***"')
    .replace(/IDENTIFIED\s+BY\s+`[^`]*`/gi, 'IDENTIFIED BY `***`')
    .replace(/PASSWORD\(\s*'[^']*'\s*\)/gi, "PASSWORD('***')")
    .replace(/PASSWORD\(\s*"[^"]*"\s*\)/gi, 'PASSWORD("***")')
    // MySQL: SET PASSWORD [FOR user] = 'xxx'  | PG: SET PASSWORD TO 'xxx' (no =)
    // PG: SET PASSWORD 'xxx' (legacy form)        | SQLite has no DCL.
    .replace(/SET\s+PASSWORD\s+(?:FOR\s+[^=;]+)?=\s*'[^']*'/gi, "SET PASSWORD = '***'")
    .replace(/SET\s+PASSWORD\s+(?:FOR\s+[^=;]+)?=\s*"[^"]*"/gi, 'SET PASSWORD = "***"')
    .replace(/SET\s+PASSWORD\s+TO\s+'[^']*'/gi, "SET PASSWORD TO '***'")
    .replace(/SET\s+PASSWORD\s+TO\s+"[^"]*"/gi, 'SET PASSWORD TO "***"')
    .replace(/SET\s+PASSWORD\s+'[^']*'/gi, "SET PASSWORD '***'")
    .replace(/SET\s+PASSWORD\s+"[^"]*"/gi, 'SET PASSWORD "***"')
    // PG: ALTER USER name WITH PASSWORD 'xxx' | MySQL: ALTER USER ... IDENTIFIED BY 'xxx'
    .replace(/WITH\s+PASSWORD\s+'[^']*'/gi, "WITH PASSWORD '***'")
    .replace(/WITH\s+PASSWORD\s+"[^"]*"/gi, 'WITH PASSWORD "***"')
}

export class AuditLog {
  readonly dir: string
  readonly enabled: boolean
  private queue: Promise<void> = Promise.resolve()
  private lastPruneDay = ''

  constructor(options: { dir: string; enabled: boolean }) {
    this.dir = options.dir
    this.enabled = options.enabled
  }

  /** Append one entry (serialized, fire-and-forget; never throws). */
  record(entry: AuditEntry): void {
    if (!this.enabled) return
    const sanitized: AuditEntry = { ...entry, ...(entry.sql === undefined ? {} : { sql: sanitizeSql(entry.sql) }) }
    this.queue = this.queue
      .then(async () => {
        const now = new Date()
        const day = dayStamp(now)
        if (day !== this.lastPruneDay) {
          this.lastPruneDay = day
          this.prune(now)
        }
        // Audit N8 (2nd round): keep the audit directory/file as tight as the
        // platform allows — mode flags are best-effort (no-op on Windows ACLs).
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
        const file = path.join(this.dir, `${day}.jsonl`)
        const existed = fs.existsSync(file)
        fs.appendFileSync(file, `${JSON.stringify(sanitized)}\n`, 'utf8')
        if (!existed) {
          try {
            fs.chmodSync(file, 0o600)
          } catch {
            /* Windows ignores POSIX modes; the profile directory ACL still applies */
          }
        }
      })
      .catch(() => undefined)
  }

  /** Await the pending append queue (used on fiber disposal and in tests). */
  async flush(): Promise<void> {
    await this.queue
  }

  /** Delete audit files older than the retention window. Returns removed count. */
  prune(now: Date = new Date()): number {
    let removed = 0
    try {
      const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000
      if (!fs.existsSync(this.dir)) return 0
      for (const name of fs.readdirSync(this.dir)) {
        const match = FILE_PATTERN.exec(name)
        if (match === null) continue
        const fileDay = new Date(`${match[1]!}T00:00:00`).getTime()
        if (Number.isFinite(fileDay) && fileDay < cutoff) {
          fs.unlinkSync(path.join(this.dir, name))
          removed += 1
        }
      }
    } catch {
      /* pruning is best-effort */
    }
    return removed
  }
}
