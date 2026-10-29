/**
 * Database dialect abstraction (PRD §6.2 / FR-15).
 *
 * Each dialect exposes a single `DatabaseDriver` interface that the rest of the
 * plugin calls into. Two drivers ship today — MySQL (the original driver via
 * `mysql2/promise`) and PostgreSQL (via `pg`). Both surface the same shape
 * (`query` / `execute` / `end`), so the tools and RPC layer never branch on
 * the driver in normal flows; only the SafetyGateway, metadata queries and
 * shadow-backup SQL are dialect-specific because their surface is SQL itself.
 */
import type { DialectId } from '../shared/types.js'

/** One row of a result set — the driver does not pre-shape the columns. */
export type Row = Record<string, unknown>

export interface ExecuteResult {
  /** Rows affected by INSERT/UPDATE/DELETE/DDL. SELECT returns 0. */
  affectedRows: number
  /** MySQL only — the auto-generated id of the first inserted row, if any. */
  insertId?: number
  /** For SELECT-shaped statements the row set is returned here. */
  rows: Row[]
}

/** Driver-agnostic surface used by the rest of the plugin. */
export interface DatabaseDriver {
  readonly dialect: DialectId
  /** Run a statement and return rows (SELECT/SHOW/DESC/EXPLAIN). */
  query(sql: string, values?: unknown[], timeoutMs?: number): Promise<Row[]>
  /**
   * Run a statement and return the change summary. INSERT/UPDATE/DELETE/DDL
   * fill `affectedRows` (and `insertId` for MySQL); SELECT-shaped statements
   * return 0 affected and the row set under `rows`.
   */
  execute(sql: string, values?: unknown[], timeoutMs?: number): Promise<ExecuteResult>
  /** Close the underlying pool/connection. */
  end(): Promise<void>
  /**
   * Run `fn` inside a database transaction. The driver hands back a
   * transaction-scoped driver; all queries inside `fn` must go through it
   * so they join the same transaction. On any thrown error the driver
   * rolls back; on normal completion it commits. The transaction-scoped
   * driver is released when `fn` returns or throws.
   *
   * Note on MySQL InnoDB: DDL statements (CREATE / DROP / ALTER) implicitly
   * commit the surrounding transaction — callers that need atomic DDL must
   * issue those statements outside withTransaction.
   */
  withTransaction<T>(fn: (tx: DatabaseDriver) => Promise<T>): Promise<T>
}

/**
 * Driver factory: one pool + driver per dialect per (name, database). The
 * returned promise resolves to a ready-to-use driver; the PoolManager owns it.
 */
export interface DriverFactoryOptions {
  connectTimeoutMs: number
  queryTimeoutMs: number
}

export type DriverFactory = (
  spec: import('../shared/types.js').ConnectionSpec,
  database: string | undefined,
  options: DriverFactoryOptions,
) => Promise<DatabaseDriver>
