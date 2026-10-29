/** Shared types for dsh-db-manager (host + client contract surface). */

export type ConnectionMode = 'readonly' | 'readwrite'
export type ConnectionScope = 'workspace' | 'global'

/**
 * Supported database dialects. The MySQL implementation is the original one
 * (PRD §6.2); PostgreSQL is an additive extension sharing every guardrail
 * (read-only gating, dangerous-statement confirmation, shadow backup). The
 * schema fills in a default of 'mysql' for every loaded connection so runtime
 * code can rely on the field being defined.
 */
export type DialectId = 'mysql' | 'postgresql' | 'sqlite'

/** Validated connection record as stored/used at runtime (password stays secret-form). */
export interface ConnectionSpec {
  name: string
  dialect: DialectId
  host?: string
  port?: number
  username?: string
  password?: string
  defaultDatabase?: string
  /** SQLite only — absolute or workspace-relative path to the database file. */
  file?: string
  ssl?: { enabled?: boolean; rejectUnauthorized?: boolean }
  extraParams?: Record<string, string>
  mode: ConnectionMode
  comment?: string
  /**
   * Display-only grouping label (v0.21): connections sharing it render under one
   * collapsible section in the settings page.
   */
  group?: string
  /**
   * FR-13: name of a reusable SSH (jump host) profile. When set, the driver
   * reaches the database through an SSH tunnel instead of connecting directly.
   * Server dialects only (a SQLite file has no remote endpoint).
   */
  sshProfile?: string
}

/** How the plugin authenticates to the SSH jump host (FR-13). */
export type SshAuthMethod = 'agent' | 'keyfile' | 'key' | 'password'

export interface SshAuthSpec {
  method: SshAuthMethod
  /** method=keyfile — private key file path (supports `~`). */
  keyPath?: string
  /** method=key — inline PEM in secret form ($ENV:VAR or enc:v1). */
  privateKey?: string
  /** optional passphrase for keyfile/key, in secret form. */
  passphrase?: string
  /** method=password — in secret form. */
  password?: string
}

/** One reusable SSH jump-host profile (declared in the global or workspace config). */
export interface SshProfileSpec {
  name: string
  host: string
  /** Defaults to 22. */
  port?: number
  username: string
  auth: SshAuthSpec
  /** known_hosts file for strict host key verification; defaults to ~/.ssh/known_hosts. */
  knownHostsPath?: string
  readyTimeoutMs?: number
  keepaliveIntervalMs?: number
}

export type DbErrorKind =
  | 'network'
  | 'auth'
  | 'unknown-database'
  | 'permission'
  | 'timeout'
  | 'syntax'
  | 'config'
  | 'unknown'

export interface DbFailure {
  kind: DbErrorKind
  message: string
  hint?: string
}

/** One connection test result (GUI status cache + db_test_connection share this shape). */
export interface ConnectionTestResult {
  name: string
  ok: boolean
  latencyMs?: number
  errorKind?: DbErrorKind
  message?: string
  hint?: string
  testedAt: number
}

/** Credential-free connection view for tool outputs. */
export interface ConnectionToolView {
  name: string
  host: string
  port: number
  defaultDatabase?: string
  mode: ConnectionMode
  scope: ConnectionScope
  isDefault: boolean
  available: boolean
  issue?: string
}
