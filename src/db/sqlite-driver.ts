/**
 * SQLite driver: thin wrapper around Node.js' built-in `node:sqlite` module
 * (Node 22+) that exposes DatabaseDriver.
 *
 * Why node:sqlite and not the npm `sqlite3` package?
 * ─────────────────────────────────────────────────────
 * `sqlite3@5.1.7` declares `binary.napi_versions: [3, 6]` — only those two
 * N-API major versions ship with prebuilt binaries. Node 24 reports
 * `process.versions.napi` as `undefined` (the project renamed the version
 * surface) so `prebuild-install` cannot match a binary and falls back to
 * `node-gyp rebuild`, which on Windows requires Visual Studio Build Tools
 * + Python. Installing the plugin then fails on any Windows box without
 * the VS toolchain. node:sqlite is a Node core module compiled into the
 * Node binary itself, so the install is zero-dep and zero-toolchain.
 *
 * Driver semantics (unchanged from the previous sqlite3-backed version):
 *   - There is no connection pool: one open Database per (name, file) triple
 *     is enough. PoolManager hands out the same instance every time.
 *   - There are no host/port/username/password fields. The configuration
 *     schema marks them optional for dialect=sqlite and `file` becomes the
 *     canonical identifier (validated in the schema's superRefine).
 *   - The read-only mode is enforced at open time via the `readOnly: true`
 *     option so a write attempt fails closed at the driver level, not just
 *     at the classification layer.
 *
 * Placeholder convention: SQLite accepts `?` (anonymous positional) which we
 * pass through unchanged — no rewrite needed.
 *
 * File-path sandboxing (audit H2): create() requires an explicit
 * `allowedRoots` allow-list. Paths must resolve to one of those roots
 * (or be the literal `:memory:`). This blocks a misconfigured or malicious
 * connection from opening `C:\Windows\SAM`, `/etc/passwd`, or any file
 * outside the user's project / approved roots. The check lives here (and in
 * pool.validateSqliteFilePath) so the GUI save path and the runtime tool
 * path both run the same boundary.
 */
// 不要改成 `import { DatabaseSync } from 'node:sqlite'`：tsup 内置的
// node-protocol 插件会把所有 `node:*` 静态导入无条件下重写为裸名
// （"node:sqlite" → "sqlite"），而 Node 没有 `sqlite` 裸名内置模块，打包产物
// 会在 DSH 启动时报 ERR_MODULE_NOT_FOUND。process.getBuiltinModule（Node 22.3+）
// 是普通运行时调用，任何打包器都不会改写它。
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
import type { ConnectionSpec } from '../shared/types.js'
import type { DatabaseDriver, DriverFactoryOptions, ExecuteResult, Row } from './dialect.js'
import { validateSqliteFilePath } from './pool.js'

interface NodeSqliteStatement {
  all(...params: unknown[]): Row[]
  get(...params: unknown[]): Row | undefined
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  readonly sourceSQL: string
}

interface NodeSqliteDatabase {
  exec(sql: string): unknown
  prepare(sql: string): NodeSqliteStatement
  close(): void
}

/** Open a `node:sqlite` database in the requested mode. */
function openDatabase(file: string, readOnly: boolean): NodeSqliteDatabase {
  const db = new DatabaseSync(file, { readOnly, allowExtension: false })
  return db as unknown as NodeSqliteDatabase
}

function toParams(values: unknown[] | undefined): unknown[] {
  return values ?? []
}

export interface SqliteDriverOptions {
  /** Absolute paths the SQLite file must resolve under; empty rejects all paths except `:memory:`. */
  allowedRoots: ReadonlyArray<string>
}

export class SqliteDriver implements DatabaseDriver {
  readonly dialect = 'sqlite' as const
  private constructor(private readonly db: NodeSqliteDatabase, private readonly resolvedFile: string) {}

  static create(spec: ConnectionSpec, _options: DriverFactoryOptions, driverOptions: SqliteDriverOptions): SqliteDriver {
    if (spec.file === undefined || spec.file.length === 0) {
      throw new Error('SQLite 连接必须填写 file（数据库文件路径）')
    }
    const resolvedFile = validateSqliteFilePath(spec.file, driverOptions.allowedRoots)
    const readOnly = spec.mode === 'readonly'
    const db = openDatabase(resolvedFile, readOnly)
    return new SqliteDriver(db, resolvedFile)
  }

  /** Exposed for tests + audit log so the caller knows the actual on-disk path after path-resolution. */
  get file(): string {
    return this.resolvedFile
  }

  async query(sql: string, values?: unknown[], _timeoutMs?: number): Promise<Row[]> {
    // node:sqlite is fully synchronous; we wrap in Promise.resolve() so the
    // driver contract stays Promise-based and the rest of the plugin keeps
    // working without an await rewrite.
    const stmt = this.db.prepare(sql)
    const rows = stmt.all(...toParams(values))
    return rows
  }

  async execute(sql: string, values?: unknown[], _timeoutMs?: number): Promise<ExecuteResult> {
    const stmt = this.db.prepare(sql)
    const result = stmt.run(...toParams(values))
    const changes = typeof result.changes === 'number' ? result.changes : Number(result.changes)
    // lastInsertRowid may be a BigInt for tables with ROWID > 2^53; coerce
    // to a finite number so the rest of the plugin (audit / response
    // shaping) keeps working with plain JSON numbers.
    const insertIdRaw = result.lastInsertRowid
    const insertId = typeof insertIdRaw === 'number'
      ? (insertIdRaw > 0 ? insertIdRaw : undefined)
      : (typeof insertIdRaw === 'bigint' && insertIdRaw > 0n ? Number(insertIdRaw) : undefined)
    return { affectedRows: changes, ...(insertId === undefined ? {} : { insertId }), rows: [] }
  }

  end(): Promise<void> {
    this.db.close()
    return Promise.resolve()
  }

  /**
   * Run `fn` inside a SQLite transaction. SQLite's `BEGIN` blocks the entire
   * database file for writes until COMMIT/ROLLBACK, so the whole
   * backup-and-execute window runs serially. DDL inside `fn` participates
   * in the transaction and is rolled back on error — no implicit commit
   * on the SQLite side.
   *
   * We reuse the same `db` handle for the transaction: queries issued
   * through `tx` are funnelled back to `this.db.prepare()` so they queue
   * behind the BEGIN/COMMIT issued via `db.exec()`.
   */
  async withTransaction<T>(fn: (tx: DatabaseDriver) => Promise<T>): Promise<T> {
    const tx: DatabaseDriver = {
      dialect: this.dialect,
      query: (sql, values, timeoutMs) => this.query(sql, values, timeoutMs),
      execute: (sql, values, timeoutMs) => this.execute(sql, values, timeoutMs),
      end: async () => undefined,
      withTransaction: () => { throw new Error('嵌套事务不支持 — withTransaction 内部不能再开一个事务') },
    }
    try {
      this.db.exec('BEGIN')
      const result = await fn(tx)
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* swallow rollback failures */ }
      throw error
    }
  }
}
