/**
 * Connection-config mutations, shared by two surfaces:
 *   - the GUI RPC layer (`connections.save` / `connections.delete`)
 *   - the model-facing `db_add_connection` tool
 *
 * Extracted from `rpc/routes.ts` so the tools layer can write configuration
 * without importing the RPC layer — `routes.ts` already imports
 * `tools/index.ts` (for `testConnection`), so reaching back from tools to
 * routes would form an import cycle.
 *
 * Guarantees preserved from the original implementation:
 *   - a file that exists but is unreadable/unparseable is NEVER overwritten
 *     (audit M5): mutations refuse instead of silently dropping every stored
 *     connection (including their ciphertext passwords);
 *   - passwords stay in secret form on disk (`$ENV:VAR` or `enc:v1:…`) —
 *     plaintext supplied by a caller is encrypted here, immediately, and the
 *     plaintext never reaches the file, the return value or the audit log;
 *   - writes are atomic (tmp file + rename) and invalidate the ConfigStore
 *     cache so the next read sees the new state.
 */
import fs from 'node:fs'
import path from 'node:path'
import { connectionSchema, formatZodIssues, sshProfileSchema } from './schema.js'
import { workspaceConfigPath, type ConfigStore } from './store.js'
import { encryptToSecret } from '../secrets.js'
import type { ConnectionSpec, SshProfileSpec } from '../shared/types.js'

export type ConnectionScope = 'global' | 'workspace'

export interface SaveOutcome {
  ok: boolean
  name?: string
  error?: string
  warnings?: string[]
  /** File that was (or would have been) written. */
  path?: string
  /** Whether a new entry was appended or an existing one replaced. */
  action?: 'created' | 'replaced'
  /** Validated spec as stored (password in secret form). */
  spec?: ConnectionSpec
}

/** Resolve the config file for a scope. Workspace scope needs a known cwd. */
export function connectionFilePath(store: ConfigStore, scope: ConnectionScope, cwd?: string): string | undefined {
  if (scope === 'global') return store.globalPath
  return workspaceConfigPath(cwd)
}

interface FileRead {
  raw?: unknown
  /** Set when the file exists but cannot be read/parsed — mutations must refuse (audit M5). */
  error?: string
}

/** Read + parse one config file, distinguishing "absent" from "broken". */
export function readConfigFile(filePath: string, label = '配置文件'): FileRead {
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { raw: { connections: [] } }
    return { error: `无法读取${label} ${filePath}：${error instanceof Error ? error.message : String(error)}。为避免覆盖丢失现有连接，本次变更被拒绝；请先恢复文件可读后重试` }
  }
  try {
    return { raw: JSON.parse(text) }
  } catch (error) {
    return { error: `${label}不是合法 JSON（${error instanceof Error ? error.message : String(error)}）。为避免覆盖丢失现有连接（含各连接的密文密码），请先修复或备份重建该文件，再重试变更` }
  }
}

/** The `connections` array of a parsed config document (empty when absent/malformed). */
export function connectionsOf(raw: unknown): Array<Record<string, unknown>> {
  const connections = (raw as { connections?: unknown } | null | undefined)?.connections
  return Array.isArray(connections) ? (connections as Array<Record<string, unknown>>) : []
}

/** Blocking sleep — the retry path is rare, tiny and synchronous by design. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Rename with a few retries.
 *
 * On Windows `fs.renameSync` can fail with EPERM/EBUSY/EACCES when another
 * process (antivirus, search indexer, an editor) momentarily holds a handle on
 * the destination — observed once as a flaky EPERM while saving a config file.
 * Those codes are transient, so retrying briefly turns an intermittent "保存失败"
 * into a normal save; anything else (e.g. ENOENT) fails immediately. The
 * atomic write guarantee is preserved: this only waits, it never falls back to
 * a non-atomic copy.
 */
export function renameWithRetry(
  from: string,
  to: string,
  rename: (a: string, b: string) => void = fs.renameSync,
  attempts = 5,
): void {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rename(from, to)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error
      if (attempt < attempts - 1) sleepSync(20 * (attempt + 1))
    }
  }
  throw lastError
}

/**
 * Write the document atomically, preserving every top-level field the caller
 * did not touch (the workspace file also carries `useGlobal` / `default`).
 */
function writeConfigFile(store: ConfigStore, filePath: string, document: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  try {
    renameWithRetry(tmp, filePath)
  } catch (error) {
    // Do not leave the temp file behind when the save ultimately fails.
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* best effort */
    }
    throw error
  }
  store.invalidate()
}

/** Result of turning a caller-supplied connection body into a validated spec. */
interface PreparedConnection {
  spec?: ConnectionSpec
  error?: string
  warnings?: string[]
}

/**
 * Validate one caller-supplied connection body and resolve its secret policy.
 *
 * `existingPassword` is the stored secret to carry over for `passwordMode:keep`
 * — from the entry being updated, or (when moving a connection between config
 * files) from the entry in the SOURCE file.
 */
function prepareConnection(input: unknown, existingPassword: string | undefined): PreparedConnection {
  if (input === null || typeof input !== 'object') return { error: 'connection 字段缺失' }
  const draft = { ...(input as Record<string, unknown>) }

  // Password policy: keep | $ENV:VAR | encrypt-typed-plaintext | raw enc ciphertext.
  const passwordMode = typeof draft.passwordMode === 'string' ? draft.passwordMode : undefined
  const passwordKeep = passwordMode === 'keep'
  const passwordEnv = passwordMode === 'env' && typeof draft.passwordEnv === 'string' ? draft.passwordEnv.trim() : undefined
  const passwordPlain = passwordMode === 'plain' && typeof draft.passwordPlain === 'string' ? draft.passwordPlain : undefined
  const passwordEnc = passwordMode === 'enc' && typeof draft.passwordEnc === 'string' ? draft.passwordEnc.trim() : undefined
  delete draft.passwordMode
  delete draft.passwordEnv
  delete draft.passwordPlain
  delete draft.passwordEnc

  // SQLite connections carry no password; the editor expresses that with
  // passwordMode='none' so we drop any password the caller may have set and
  // (on edit) clear the previously stored one if it existed.
  if (passwordMode === 'none') {
    delete draft.password
  } else if (passwordKeep || (passwordMode === undefined && existingPassword !== undefined && draft.password === undefined)) {
    if (existingPassword === undefined) return { error: '没有可保留的既有密码：新连接必须提供密码' }
    draft.password = existingPassword
  } else if (passwordEnv !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(passwordEnv)) return { error: '环境变量名不合法' }
    draft.password = `$ENV:${passwordEnv}`
  } else if (passwordEnc !== undefined) {
    draft.password = passwordEnc
  } else if (passwordPlain !== undefined) {
    if (passwordPlain.length === 0) return { error: '密码不能为空' }
    draft.password = encryptToSecret(passwordPlain)
  } else if (draft.password === undefined) {
    return { error: '必须提供密码（保留已有 / $ENV:VAR / 密文 / 明文即时加密；SQLite 连接请用 passwordMode: "none"）' }
  }

  const parsed = connectionSchema.safeParse(draft)
  if (!parsed.success) return { error: '连接字段未通过校验', warnings: formatZodIssues(parsed.error) }
  return { spec: parsed.data }
}

/**
 * Insert or update one connection in the chosen config file.
 *
 * Body shape (same contract the GUI RPC uses):
 *   { originalName?, connection: { …, passwordMode: keep|env|plain|enc|none,
 *                                  passwordEnv?, passwordPlain?, passwordEnc? } }
 *
 * `originalName` targets an existing entry for update; without it a name
 * collision is refused (callers that mean "replace" pass `originalName`).
 */
export function saveConnectionInto(
  store: ConfigStore,
  target: { scope: ConnectionScope; cwd?: string },
  body: Record<string, unknown>,
): SaveOutcome {
  const filePath = connectionFilePath(store, target.scope, target.cwd)
  if (filePath === undefined) {
    return { ok: false, error: '无法确定工作区配置文件路径：本次调用缺少工作区目录信息' }
  }
  const label = target.scope === 'global' ? '全局配置文件' : '工作区配置文件'
  const read = readConfigFile(filePath, label)
  if (read.error !== undefined) return { ok: false, error: read.error }
  const originalName = typeof body.originalName === 'string' ? body.originalName : undefined

  const connections = connectionsOf(read.raw)
  const existingEntry = originalName !== undefined ? connections.find((entry) => entry['name'] === originalName) : undefined
  const existingPassword = typeof existingEntry?.['password'] === 'string' ? (existingEntry['password'] as string) : undefined

  const prepared = prepareConnection(body.connection, existingPassword)
  if (prepared.error !== undefined) {
    return { ok: false, error: prepared.error, ...(prepared.warnings === undefined ? {} : { warnings: prepared.warnings }), path: filePath }
  }
  const spec = prepared.spec!

  // Replace only when the caller explicitly names the existing entry.
  // Without `originalName` this is an INSERT: a same-name entry is a conflict,
  // not a silent overwrite. (The previous implementation resolved targetIndex
  // by `originalName ?? spec.name`, so "add" silently behaved as "upsert" and
  // the conflict check could never fire.)
  const targetIndex = originalName !== undefined ? connections.findIndex((entry) => entry['name'] === originalName) : -1
  const conflicts = connections.some((entry, index) => entry['name'] === spec.name && index !== targetIndex)
  if (conflicts) return { ok: false, error: `已存在同名连接 "${spec.name}"`, path: filePath }
  const action: 'created' | 'replaced' = targetIndex >= 0 ? 'replaced' : 'created'
  if (targetIndex >= 0) connections[targetIndex] = spec as unknown as Record<string, unknown>
  else connections.push(spec as unknown as Record<string, unknown>)
  const document = { ...(read.raw as Record<string, unknown>), connections }
  writeConfigFile(store, filePath, document)
  return { ok: true, name: spec.name, path: filePath, action, spec }
}

/** Convenience wrapper for the global file (keeps the historical signature). */
export function saveConnection(store: ConfigStore, body: Record<string, unknown>): SaveOutcome {
  return saveConnectionInto(store, { scope: 'global' }, body)
}

/** Remove one connection from the chosen config file (global or workspace). */
export function deleteConnectionFrom(
  store: ConfigStore,
  target: { scope: ConnectionScope; cwd?: string },
  name: string,
): { ok: boolean; error?: string; path?: string } {
  if (name.length === 0) return { ok: false, error: '缺少连接名' }
  const filePath = connectionFilePath(store, target.scope, target.cwd)
  if (filePath === undefined) {
    return { ok: false, error: '无法确定工作区配置文件路径：本次调用缺少工作区目录信息' }
  }
  const label = target.scope === 'global' ? '全局配置文件' : '工作区配置文件'
  const read = readConfigFile(filePath, label)
  if (read.error !== undefined) return { ok: false, error: read.error }
  const connections = connectionsOf(read.raw)
  const index = connections.findIndex((entry) => entry['name'] === name)
  if (index < 0) return { ok: false, error: `连接 "${name}" 不存在`, path: filePath }
  connections.splice(index, 1)
  writeConfigFile(store, filePath, { ...(read.raw as Record<string, unknown>), connections })
  return { ok: true, path: filePath }
}

/** Refuse instead of wiping the file when it exists but is unreadable/unparseable (audit M5). */
export function deleteConnection(store: ConfigStore, name: string): { ok: boolean; error?: string } {
  return deleteConnectionFrom(store, { scope: 'global' }, name)
}

/* ── SSH profiles (FR-13) ────────────────────────────────────────────────── */

/** How a caller supplies one secret field (mirrors the GUI password modes). */
export interface SecretFieldInput {
  mode?: 'keep' | 'plain' | 'env' | 'enc' | 'none'
  plain?: string
  env?: string
  enc?: string
}

/**
 * Resolve one secret field into its stored form. Same policy as the database
 * password: secrets on disk are only ever `$ENV:VAR` or `enc:v1:…`; plaintext
 * from the caller is encrypted here, never written as-is.
 */
export function resolveSecretField(
  input: SecretFieldInput | undefined,
  existing: string | undefined,
  label: string,
): { value?: string; error?: string } {
  const mode = input?.mode
  if (mode === 'none') return {}
  if (mode === undefined || mode === 'keep') {
    return existing === undefined ? {} : { value: existing }
  }
  // An empty value means "this profile simply has no such secret" — a private
  // key without a passphrase is legal, and a client may send an untouched
  // optional field anyway. Required-ness is enforced afterwards by
  // sshProfileSchema's superRefine, which knows the auth method and therefore
  // produces a method-specific message instead of a generic "empty" error.
  if (mode === 'env') {
    const envName = typeof input?.env === 'string' ? input.env.trim() : ''
    if (envName.length === 0) return {}
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) return { error: `${label}：环境变量名不合法` }
    return { value: `$ENV:${envName}` }
  }
  if (mode === 'enc') {
    const cipher = typeof input?.enc === 'string' ? input.enc.trim() : ''
    if (cipher.length === 0) return {}
    if (!cipher.startsWith('enc:v1:')) return { error: `${label}：密文必须是 enc:v1:… 形式` }
    return { value: cipher }
  }
  // mode === 'plain'
  const plain = typeof input?.plain === 'string' ? input.plain : ''
  if (plain.length === 0) return {}
  return { value: encryptToSecret(plain) }
}

function sshProfilesOf(raw: unknown): Array<Record<string, unknown>> {
  const profiles = (raw as { sshProfiles?: unknown } | null | undefined)?.sshProfiles
  return Array.isArray(profiles) ? (profiles as Array<Record<string, unknown>>) : []
}

export interface SshSaveOutcome extends SaveOutcome {
  action?: 'created' | 'replaced'
}

/**
 * Insert or update one reusable SSH profile (FR-13) in the chosen config file.
 *
 * Body shape:
 *   { originalName?, profile: { name, host, port?, username, knownHostsPath?,
 *     readyTimeoutMs?, keepaliveIntervalMs?,
 *     auth: { method, keyPath?, privateKey?/passphrase?/password?: SecretFieldInput } } }
 *
 * Without `originalName` this is an INSERT — an existing name is a conflict.
 */
export function saveSshProfileInto(
  store: ConfigStore,
  target: { scope: ConnectionScope; cwd?: string },
  body: Record<string, unknown>,
): SshSaveOutcome {
  const filePath = connectionFilePath(store, target.scope, target.cwd)
  if (filePath === undefined) {
    return { ok: false, error: '无法确定工作区配置文件路径：本次调用缺少工作区目录信息' }
  }
  const label = target.scope === 'global' ? '全局配置文件' : '工作区配置文件'
  const read = readConfigFile(filePath, label)
  if (read.error !== undefined) return { ok: false, error: read.error }

  const input = body.profile
  if (input === null || typeof input !== 'object') return { ok: false, error: 'profile 字段缺失' }
  const draft = { ...(input as Record<string, unknown>) }
  const authInput = (draft.auth ?? {}) as Record<string, unknown>
  delete draft.auth

  const originalName = typeof body.originalName === 'string' ? body.originalName : undefined
  const profiles = sshProfilesOf(read.raw)
  const existingEntry = originalName === undefined ? undefined : profiles.find((entry) => entry['name'] === originalName)
  const existingAuth = (existingEntry?.['auth'] ?? {}) as Record<string, unknown>
  const existingSecret = (field: string): string | undefined => {
    const value = existingAuth[field]
    return typeof value === 'string' ? value : undefined
  }

  const method = typeof authInput.method === 'string' ? authInput.method : ''
  const auth: Record<string, unknown> = { method }
  if (typeof authInput.keyPath === 'string' && authInput.keyPath.trim().length > 0) auth.keyPath = authInput.keyPath.trim()
  // Only keep the secret that belongs to the selected method; a leftover value
  // from another method would be dead weight (and confusing) on disk.
  const secretFields: Array<{ field: 'privateKey' | 'passphrase' | 'password'; label: string; relevant: boolean }> = [
    { field: 'privateKey', label: 'SSH 私钥内容', relevant: method === 'key' },
    { field: 'passphrase', label: 'SSH 私钥口令', relevant: method === 'key' || method === 'keyfile' },
    { field: 'password', label: 'SSH 密码', relevant: method === 'password' },
  ]
  for (const { field, label: fieldLabel, relevant } of secretFields) {
    const resolved = resolveSecretField(
      relevant ? (authInput[field] as SecretFieldInput | undefined) : { mode: 'none' },
      existingSecret(field),
      fieldLabel,
    )
    if (resolved.error !== undefined) return { ok: false, error: resolved.error, path: filePath }
    if (resolved.value !== undefined) auth[field] = resolved.value
  }
  draft.auth = auth

  const parsed = sshProfileSchema.safeParse(draft)
  if (!parsed.success) return { ok: false, error: 'SSH 配置字段未通过校验', warnings: formatZodIssues(parsed.error), path: filePath }
  const profile = parsed.data

  const targetIndex = originalName !== undefined ? profiles.findIndex((entry) => entry['name'] === originalName) : -1
  const conflicts = profiles.some((entry, index) => entry['name'] === profile.name && index !== targetIndex)
  if (conflicts) return { ok: false, error: `已存在同名 SSH 配置 "${profile.name}"`, path: filePath }
  const action: 'created' | 'replaced' = targetIndex >= 0 ? 'replaced' : 'created'
  if (targetIndex >= 0) profiles[targetIndex] = profile as unknown as Record<string, unknown>
  else profiles.push(profile as unknown as Record<string, unknown>)

  writeConfigFile(store, filePath, { ...(read.raw as Record<string, unknown>), sshProfiles: profiles })
  return { ok: true, name: profile.name, path: filePath, action, spec: undefined }
}

/** Remove one SSH profile from the chosen config file. */
export function deleteSshProfileFrom(
  store: ConfigStore,
  target: { scope: ConnectionScope; cwd?: string },
  name: string,
): { ok: boolean; error?: string; path?: string } {
  if (name.length === 0) return { ok: false, error: '缺少 SSH 配置名' }
  const filePath = connectionFilePath(store, target.scope, target.cwd)
  if (filePath === undefined) return { ok: false, error: '无法确定工作区配置文件路径：本次调用缺少工作区目录信息' }
  const label = target.scope === 'global' ? '全局配置文件' : '工作区配置文件'
  const read = readConfigFile(filePath, label)
  if (read.error !== undefined) return { ok: false, error: read.error }
  const profiles = sshProfilesOf(read.raw)
  const index = profiles.findIndex((entry) => entry['name'] === name)
  if (index < 0) return { ok: false, error: `SSH 配置 "${name}" 不存在`, path: filePath }
  profiles.splice(index, 1)
  writeConfigFile(store, filePath, { ...(read.raw as Record<string, unknown>), sshProfiles: profiles })
  return { ok: true, path: filePath }
}

/** Convenience wrapper for the global file. */
export function deleteSshProfile(store: ConfigStore, name: string): { ok: boolean; error?: string } {
  return deleteSshProfileFrom(store, { scope: 'global' }, name)
}

/* ── duplicating a connection ────────────────────────────────────────────── */

export interface DuplicateOutcome extends Omit<SaveOutcome, 'action'> {
  action?: 'duplicated'
  fromPath?: string
  toPath?: string
}

/**
 * Copy one connection (v0.21): same endpoint, credentials and SSH tunnel, a new
 * name — the fast path for "one server, several databases".
 *
 * The copy is made from the **stored** entry, so the secret travels verbatim
 * (`enc:v1:…` / `$ENV:VAR`) and is never decrypted here. Only the fields people
 * actually change for a sibling database can be overridden (`name`,
 * `defaultDatabase`, `group`); everything else is identical to the source, and
 * the result is validated before writing, so a malformed source entry can never
 * be propagated.
 *
 * Naming: an explicit `name` that already exists is an error (same contract as
 * save), while the default `<source>-副本` is auto-disambiguated with `-2`, `-3`…
 */
export function duplicateConnection(
  store: ConfigStore,
  source: ConnectionTarget,
  target: ConnectionTarget,
  body: Record<string, unknown>,
): DuplicateOutcome {
  const fromPath = connectionFilePath(store, source.scope, source.cwd)
  if (fromPath === undefined) return { ok: false, error: '无法确定源配置文件路径：本次调用缺少工作区目录信息' }
  const toPath = connectionFilePath(store, target.scope, target.cwd)
  if (toPath === undefined) return { ok: false, error: '无法确定目标配置文件路径：本次调用缺少工作区目录信息' }

  const fromLabel = source.scope === 'global' ? '全局配置文件' : '工作区配置文件'
  const toLabel = target.scope === 'global' ? '全局配置文件' : '工作区配置文件'
  const fromRead = readConfigFile(fromPath, fromLabel)
  if (fromRead.error !== undefined) return { ok: false, error: fromRead.error, fromPath, toPath }
  const toRead = fromPath === toPath ? fromRead : readConfigFile(toPath, toLabel)
  if (toRead.error !== undefined) return { ok: false, error: toRead.error, fromPath, toPath }

  const originalName = typeof body.originalName === 'string' && body.originalName.length > 0 ? body.originalName : undefined
  if (originalName === undefined) {
    return { ok: false, error: '缺少 originalName：复制需要指定源连接名', fromPath, toPath }
  }
  const sourceEntry = connectionsOf(fromRead.raw).find((entry) => entry['name'] === originalName)
  if (sourceEntry === undefined) {
    return { ok: false, error: `连接 "${originalName}" 不存在（${fromLabel}：${fromPath}）`, fromPath, toPath }
  }

  const copy: Record<string, unknown> = { ...sourceEntry }
  const requested = typeof body.name === 'string' ? body.name.trim() : ''
  const toConnections = connectionsOf(toRead.raw)
  const taken = new Set(toConnections.map((entry) => entry['name']).filter((n): n is string => typeof n === 'string'))

  if (requested.length > 0) {
    if (taken.has(requested)) {
      return { ok: false, error: `目标位置已存在同名连接 "${requested}"：请换个名字`, fromPath, toPath }
    }
    copy['name'] = requested
  } else {
    const base = `${originalName}-副本`
    let candidate = base
    for (let i = 2; taken.has(candidate) && i < 1000; i += 1) candidate = `${base}${i}`
    copy['name'] = candidate
  }

  // Only the fields that differ for a sibling database; absent means "keep the
  // source value", `null`/'' means "clear it".
  for (const field of ['defaultDatabase', 'group'] as const) {
    if (!(field in body)) continue
    const value = body[field]
    if (value === null || value === '') delete copy[field]
    else if (typeof value === 'string') copy[field] = value.trim()
  }

  const parsed = connectionSchema.safeParse(copy)
  if (!parsed.success) {
    return {
      ok: false,
      error: `源连接 "${originalName}" 无法复制：字段未通过校验（请先修正源连接）`,
      warnings: formatZodIssues(parsed.error),
      fromPath,
      toPath,
    }
  }
  const spec = parsed.data

  toConnections.push(spec as unknown as Record<string, unknown>)
  writeConfigFile(store, toPath, { ...(toRead.raw as Record<string, unknown>), connections: toConnections })
  return { ok: true, name: spec.name, path: toPath, action: 'duplicated', fromPath, toPath, spec }
}

/* ── moving a connection between config files ────────────────────────────── */

export interface ConnectionTarget {
  scope: ConnectionScope
  cwd?: string
}

/** Result of a move; `action` widens SaveOutcome's set with `'moved'`. */
export interface MoveOutcome extends Omit<SaveOutcome, 'action'> {
  action?: 'moved' | 'updated' | 'created' | 'replaced'
  fromPath?: string
  toPath?: string
  /** Set when the target write succeeded but removing the source entry failed. */
  warning?: string
}

/**
 * Move (or update in place) one connection between the global file and a
 * project's file — the "编辑时更改所属" feature.
 *
 * Body shape is the same as `saveConnectionInto` (`originalName?`, `connection`
 * with its passwordMode), with two differences that matter:
 *
 *   - `passwordMode: 'keep'` resolves against the entry in the SOURCE file, so a
 *     relocation preserves the stored secret without ever decrypting it here;
 *   - the operation touches TWO files, so it is staged to fail safely: both
 *     files are read and fully validated BEFORE anything is written, the target
 *     is written first (a half-applied move leaves a duplicate, never a loss),
 *     and if removing the source entry then fails the caller is told explicitly
 *     that the connection now exists in both places.
 */
export function moveConnection(
  store: ConfigStore,
  from: ConnectionTarget,
  to: ConnectionTarget,
  body: Record<string, unknown>,
): MoveOutcome {
  const fromPath = connectionFilePath(store, from.scope, from.cwd)
  if (fromPath === undefined) return { ok: false, error: '无法确定源配置文件路径：本次调用缺少工作区目录信息' }
  const toPath = connectionFilePath(store, to.scope, to.cwd)
  if (toPath === undefined) return { ok: false, error: '无法确定目标配置文件路径：本次调用缺少工作区目录信息' }

  // Same file → ordinary update/replace (no cross-file staging needed).
  if (fromPath === toPath) {
    const saved = saveConnectionInto(store, to, body)
    return { ...saved, action: saved.ok ? 'updated' : undefined, fromPath, toPath }
  }

  const fromLabel = from.scope === 'global' ? '全局配置文件' : '工作区配置文件'
  const toLabel = to.scope === 'global' ? '全局配置文件' : '工作区配置文件'
  const fromRead = readConfigFile(fromPath, fromLabel)
  if (fromRead.error !== undefined) return { ok: false, error: fromRead.error, fromPath, toPath }
  const toRead = readConfigFile(toPath, toLabel)
  if (toRead.error !== undefined) return { ok: false, error: toRead.error, fromPath, toPath }

  const originalName = typeof body.originalName === 'string' && body.originalName.length > 0
    ? body.originalName
    : (body.connection as { name?: unknown } | undefined)?.name
  if (typeof originalName !== 'string' || originalName.length === 0) {
    return { ok: false, error: '缺少 originalName：搬迁需要知道当前所属位置里的连接名', fromPath, toPath }
  }

  const fromConnections = connectionsOf(fromRead.raw)
  const sourceIndex = fromConnections.findIndex((entry) => entry['name'] === originalName)
  if (sourceIndex < 0) {
    return { ok: false, error: `连接 "${originalName}" 在源位置不存在（${fromLabel}：${fromPath}）`, fromPath, toPath }
  }
  const sourcePassword = typeof fromConnections[sourceIndex]?.['password'] === 'string'
    ? (fromConnections[sourceIndex]!['password'] as string)
    : undefined

  const prepared = prepareConnection(body.connection, sourcePassword)
  if (prepared.error !== undefined) {
    return { ok: false, error: prepared.error, ...(prepared.warnings === undefined ? {} : { warnings: prepared.warnings }), fromPath, toPath }
  }
  const spec = prepared.spec!

  const toConnections = connectionsOf(toRead.raw)
  if (toConnections.some((entry) => entry['name'] === spec.name)) {
    return {
      ok: false,
      error: `目标位置已存在同名连接 "${spec.name}"：请改个名字，或先删除/重命名目标位置的那一条`,
      fromPath,
      toPath,
    }
  }

  // Stage 1 — write the destination (duplicate-on-failure is recoverable).
  toConnections.push(spec as unknown as Record<string, unknown>)
  writeConfigFile(store, toPath, { ...(toRead.raw as Record<string, unknown>), connections: toConnections })

  // Stage 2 — drop the source entry.
  fromConnections.splice(sourceIndex, 1)
  try {
    writeConfigFile(store, fromPath, { ...(fromRead.raw as Record<string, unknown>), connections: fromConnections })
  } catch (error) {
    return {
      ok: true,
      name: spec.name,
      path: toPath,
      action: 'moved',
      fromPath,
      toPath,
      spec,
      warning: `已写入目标位置，但移除源位置条目失败：${error instanceof Error ? error.message : String(error)}。该连接目前可能同时存在于两处（${fromPath} 与 ${toPath}），请手动确认`,
    }
  }

  return { ok: true, name: spec.name, path: toPath, action: 'moved', fromPath, toPath, spec }
}
