/**
 * Usage tracking (会话/工作区 ↔ 连接关联): every db_* access through a
 * connection records which session and workspace used it.
 *
 * - Session detail lives in process memory only (sessions die with the host).
 * - Workspace aggregation is persisted to usage.json so the GUI can answer
 *   "which workspaces are related to this database" across restarts.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface SessionUsage {
  sessionId: string
  cwd?: string
  lastUsedAt: number
  count: number
  lastAction?: string
}

export interface WorkspaceUsageEntry {
  lastUsedAt: number
  count: number
}

export interface ConnectionUsageSnapshot {
  sessions: SessionUsage[]
  workspaces: Array<{ path: string; lastUsedAt: number; count: number }>
}

const SESSIONS_PER_CONNECTION = 32
const WORKSPACES_MAX = 64

interface PersistedFile {
  version: 1
  workspaces: Record<string, Record<string, WorkspaceUsageEntry>>
}

export class UsageTracker {
  private readonly sessions = new Map<string, Map<string, SessionUsage>>()
  private readonly workspaces = new Map<string, Map<string, WorkspaceUsageEntry>>()
  private readonly file: string
  private readonly now: () => number
  private queue: Promise<void> = Promise.resolve()

  constructor(options: { file: string; now?: () => number }) {
    this.file = options.file
    this.now = options.now ?? Date.now
    this.load()
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as PersistedFile
      if (raw?.version !== 1 || typeof raw.workspaces !== 'object') return
      for (const [wsPath, connections] of Object.entries(raw.workspaces)) {
        const inner = new Map<string, WorkspaceUsageEntry>()
        for (const [connection, entry] of Object.entries(connections ?? {})) {
          if (typeof entry?.lastUsedAt === 'number' && typeof entry?.count === 'number') inner.set(connection, entry)
        }
        this.workspaces.set(wsPath, inner)
      }
    } catch {
      /* missing or corrupt file starts fresh */
    }
  }

  /** Record one tool access of a connection from a session/workspace. */
  record(connection: string, sessionId: string | undefined, cwd: string | undefined, action?: string): void {
    if (connection.length === 0) return
    const now = this.now()
    if (sessionId !== undefined && sessionId.length > 0) {
      const perConnection = this.sessions.get(connection) ?? new Map<string, SessionUsage>()
      const existing = perConnection.get(sessionId)
      if (existing !== undefined) {
        existing.lastUsedAt = now
        existing.count += 1
        existing.lastAction = action
        if (cwd !== undefined) existing.cwd = cwd
      } else {
        perConnection.set(sessionId, { sessionId, ...(cwd === undefined ? {} : { cwd }), lastUsedAt: now, count: 1, ...(action === undefined ? {} : { lastAction: action }) })
        if (perConnection.size > SESSIONS_PER_CONNECTION) {
          const oldest = [...perConnection.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
          if (oldest !== undefined) perConnection.delete(oldest.sessionId)
        }
      }
      this.sessions.set(connection, perConnection)
    }
    if (cwd !== undefined && cwd.length > 0) {
      const perWorkspace = this.workspaces.get(cwd) ?? new Map<string, WorkspaceUsageEntry>()
      const existing = perWorkspace.get(connection)
      if (existing !== undefined) {
        existing.lastUsedAt = now
        existing.count += 1
      } else {
        perWorkspace.set(connection, { lastUsedAt: now, count: 1 })
        if (this.workspaces.size > WORKSPACES_MAX) {
          const oldest = [...this.workspaces.entries()].sort((a, b) => this.maxTs(b[1]) - this.maxTs(a[1]))[0]
          if (oldest !== undefined) this.workspaces.delete(oldest[0])
        }
      }
      this.workspaces.set(cwd, perWorkspace)
    }
    this.scheduleSave()
  }

  /**
   * Workspace paths this process knows about: persisted usage entries plus the
   * cwd of every live session. Backs the GUI「项目」tab project list — the plugin
   * only ever knows projects it has actually served, never the whole disk.
   * Sorted by most-recent activity.
   */
  workspacePaths(): string[] {
    const seen = new Map<string, number>()
    for (const [wsPath, inner] of this.workspaces) seen.set(wsPath, this.maxTs(inner))
    for (const perConnection of this.sessions.values()) {
      for (const session of perConnection.values()) {
        if (session.cwd === undefined || session.cwd.length === 0) continue
        seen.set(session.cwd, Math.max(seen.get(session.cwd) ?? 0, session.lastUsedAt))
      }
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([wsPath]) => wsPath)
  }

  /** True when this exact workspace path is one the tracker has observed. */
  knowsWorkspace(wsPath: string): boolean {
    if (this.workspaces.has(wsPath)) return true
    for (const perConnection of this.sessions.values()) {
      for (const session of perConnection.values()) {
        if (session.cwd === wsPath) return true
      }
    }
    return false
  }

  /** In-memory + persisted usage snapshot for the GUI. */
  snapshot(): Record<string, ConnectionUsageSnapshot> {
    const result: Record<string, ConnectionUsageSnapshot> = {}
    const connections = new Set<string>()
    for (const [connection] of this.sessions) connections.add(connection)
    for (const inner of this.workspaces.values()) for (const connection of inner.keys()) connections.add(connection)
    for (const connection of connections) {
      const sessions = [...(this.sessions.get(connection)?.values() ?? [])].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      const workspaces = [...this.workspaces.entries()]
        .filter(([, inner]) => inner.has(connection))
        .map(([wsPath, inner]) => ({ path: wsPath, ...(inner.get(connection) as WorkspaceUsageEntry) }))
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      result[connection] = { sessions, workspaces }
    }
    return result
  }

  async flush(): Promise<void> {
    await this.queue
  }

  private maxTs(inner: Map<string, WorkspaceUsageEntry>): number {
    let max = 0
    for (const entry of inner.values()) max = Math.max(max, entry.lastUsedAt)
    return max
  }

  private scheduleSave(): void {
    this.queue = this.queue
      .then(async () => {
        const payload: PersistedFile = { version: 1, workspaces: {} }
        for (const [wsPath, inner] of this.workspaces) {
          payload.workspaces[wsPath] = Object.fromEntries(inner)
        }
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        const tmp = `${this.file}.tmp-${process.pid}`
        fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
        fs.renameSync(tmp, this.file)
      })
      .catch(() => undefined)
  }
}
