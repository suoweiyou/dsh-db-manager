/** Strict zod schemas for dsh-db-manager configuration files. */
import { z } from 'zod'

/**
 * Driver options that must never be set through extraParams (audit M6):
 * they would override the connection identity/TLS or weaken driver-level
 * safeguards (multi-statement, local infile). Legitimate tuning options
 * (timezone, charset, ...) stay accepted.
 */
export const FORBIDDEN_EXTRA_PARAMS = new Set([
  'host',
  'port',
  'user',
  'password',
  'database',
  'socketpath',
  'ssl',
  'multiplestatements',
  'stream',
  'localinfile',
  'infilestreamfactory',
  'authswitchhandler',
  // v0.16 hardening: mysql2 merges `flags` into its capability defaults, so it
  // is a second route to LOCAL_FILES / MULTIPLE_STATEMENTS — banned alongside
  // the options it overrides.
  'flags',
  // Audit N1 (2nd round): mysql2's ConnectionConfig merges URI-derived options
  // (including query-string flags like multipleStatements/localInfile/ssl) for
  // every key that is not pre-set. The denylist above cannot inspect inside a
  // URI value, so the uri/connectionString keys themselves must be banned.
  'uri',
  'connectionstring',
])

const extraParamsSchema = z
  .record(z.string(), z.string())
  .refine((params) => !Object.keys(params).some((key) => FORBIDDEN_EXTRA_PARAMS.has(key.toLowerCase())), {
    message:
      'extraParams 禁止覆盖安全相关驱动选项（host/port/user/password/database/socketPath/ssl/multipleStatements/localInfile/uri/connectionString 等）：连接目标请使用连接字段本身，TLS 请使用 ssl.enabled',
  })

/**
 * Password secret rules: every dialect that carries a password (mysql/postgresql)
 * must use `$ENV:VAR` or `enc:v1:…`. SQLite connections skip this rule entirely
 * (they have no password field).
 */
export const passwordSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith('$ENV:') || value.startsWith('enc:v1:'), {
    message: '密码不允许明文：请使用 "$ENV:VAR_NAME" 环境变量引用，或 "enc:v1:…" 密文（node bin/encrypt.js 生成）',
  })

const sslSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    rejectUnauthorized: z.boolean().optional(),
  })
  .optional()

const baseCommon = {
  comment: z.string().optional(),
  /**
   * Display-only grouping label (v0.21). Connections sharing a value render
   * under one collapsible section — the usual case is one server hosting
   * several databases (dev/stage/test) that would otherwise clutter the list.
   * Deliberately free-form (no separate registry): a group exists exactly as
   * long as some connection names it, so nothing has to be cleaned up.
   */
  group: z.string().min(1).max(64).optional(),
  extraParams: extraParamsSchema.optional(),
  mode: z.enum(['readonly', 'readwrite']).default('readonly'),
  ssl: sslSchema,
}

/** MySQL/PostgreSQL share the same shape (host/port/user/password + optional defaultDatabase). */
const mysqlLikeSchema = z
  .strictObject({
    name: z.string().min(1, 'name 不能为空'),
    dialect: z.enum(['mysql', 'postgresql']),
    host: z.string().min(1, 'host 不能为空'),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().min(1, 'username 不能为空'),
    password: passwordSchema,
    defaultDatabase: z.string().min(1).optional(),
    // FR-13: optional reference to a reusable SSH (jump host) profile declared
    // in the same config file or the global one. Only server dialects can be
    // tunnelled — a SQLite file has no remote endpoint.
    sshProfile: z.string().min(1).optional(),
    ...baseCommon,
  })
  .transform((value) => ({ ...value, port: value.port ?? 3306 }))

const sqliteSchema = z
  .strictObject({
    name: z.string().min(1, 'name 不能为空'),
    dialect: z.literal('sqlite'),
    // Optional here so a missing key doesn't produce a generic
    // "expected string, received undefined" — superRefine below gives the
    // user a message that names the missing field.
    file: z.string().min(1, 'SQLite 连接的 file 路径不能为空').optional(),
    defaultDatabase: z.string().min(1).optional(),
    ...baseCommon,
  })
  .superRefine((value, ctx) => {
    if (value.file === undefined || value.file.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['file'], message: 'dialect=sqlite 必须填写 file（数据库文件路径）' })
    }
  })
  .transform((value) => ({ ...value, port: undefined as number | undefined }))

/**
 * Secret-shaped string usable for SSH material (private key / passphrase /
 * password). Same rule as database passwords: `$ENV:VAR` reference or
 * `enc:v1:` AES-256-GCM ciphertext — plaintext never reaches the config file.
 */
const secretString = z
  .string()
  .min(1)
  .refine((value) => value.startsWith('$ENV:') || value.startsWith('enc:v1:'), {
    message: '该字段不允许明文：请使用 "$ENV:VAR_NAME" 环境变量引用，或 "enc:v1:…" 密文（node bin/encrypt.js 生成）',
  })

const sshAuthSchema = z
  .strictObject({
    /** agent = 使用本机 ssh-agent；keyfile = 私钥文件路径；key = 内联 PEM；password = 密码登录 */
    method: z.enum(['agent', 'keyfile', 'key', 'password']),
    keyPath: z.string().min(1).optional(),
    privateKey: secretString.optional(),
    passphrase: secretString.optional(),
    password: secretString.optional(),
  })
  .superRefine((value, ctx) => {
    const need = (field: 'keyPath' | 'privateKey' | 'password', message: string) => {
      if (value[field] === undefined || value[field]!.length === 0) {
        ctx.addIssue({ code: 'custom', path: [field], message })
      }
    }
    if (value.method === 'keyfile') need('keyPath', 'SSH 认证方式 keyfile 必须提供 keyPath（私钥文件路径）')
    if (value.method === 'key') need('privateKey', 'SSH 认证方式 key 必须提供 privateKey（PEM 内容，$ENV: 或 enc:v1 形式）')
    if (value.method === 'password') need('password', 'SSH 认证方式 password 必须提供 password（$ENV: 或 enc:v1 形式）')
  })

/**
 * FR-22 — read-only log sources. A source is the ONLY place a remote path or a
 * systemd unit name is ever written: tool arguments carry a source name, so no
 * caller-supplied text can reach a filesystem path or a command line.
 *
 * Validation is therefore deliberately strict and happens at save time (both
 * the GUI editor and `db_add_ssh_log_source` go through this schema):
 *   - `path` must be absolute POSIX without any `..` segment,
 *   - `unit` must match `^[A-Za-z0-9@._:-]{1,64}$` — the character set
 *     `journalctl -u` accepts; anything else could smuggle shell syntax into
 *     the (fixed-template) journal command,
 *   - `kind` decides which of the two is required (the other is rejected, not
 *     ignored, so a typo cannot silently produce an unreadable source).
 */
const SSH_LOG_UNIT_PATTERN = /^[A-Za-z0-9@._:-]{1,64}$/

function isAbsolutePosixPath(value: string): boolean {
  if (!value.startsWith('/')) return false
  if (value.includes('\0')) return false
  const segments = value.split('/')
  return !segments.some((segment) => segment === '..' || segment === '.')
}

export const sshLogSourceSchema = z
  .strictObject({
    name: z.string().min(1, '日志源名不能为空').max(64, '日志源名最长 64 个字符'),
    kind: z.enum(['file', 'journal']),
    path: z.string().min(1, '日志路径不能为空').max(1024, '日志路径过长').optional(),
    unit: z.string().min(1, 'systemd 单元名不能为空').max(64, 'systemd 单元名最长 64 个字符').optional(),
    label: z.string().max(120, '说明最长 120 个字符').optional(),
    via: z.string().min(1, 'via 不能为空字符串').max(64, 'via 最长 64 个字符').optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'file') {
      if (value.path === undefined) {
        ctx.addIssue({ code: 'custom', path: ['path'], message: 'kind=file 必须填写日志文件的绝对路径（path）' })
      } else if (!isAbsolutePosixPath(value.path)) {
        ctx.addIssue({
          code: 'custom',
          path: ['path'],
          message: '日志路径必须是以 "/" 开头的绝对路径，且不能包含 "." 或 ".." 路径段',
        })
      }
      if (value.unit !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['unit'], message: 'kind=file 不能填写 unit（unit 只用于 kind=journal）' })
      }
      return
    }
    if (value.unit === undefined) {
      ctx.addIssue({ code: 'custom', path: ['unit'], message: 'kind=journal 必须填写 systemd 单元名（unit），例如 app.service' })
    } else if (!SSH_LOG_UNIT_PATTERN.test(value.unit)) {
      ctx.addIssue({
        code: 'custom',
        path: ['unit'],
        message: 'systemd 单元名只能包含字母、数字与 @ . _ : - ，长度 1–64（例如 app.service、ssh@eth0.service）',
      })
    }
    if (value.path !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['path'], message: 'kind=journal 不能填写 path（path 只用于 kind=file）' })
    }
  })

/** Max log sources per SSH profile — keeps a typo'd paste from exploding the config. */
export const MAX_LOG_SOURCES_PER_PROFILE = 20

/** One reusable SSH (jump host) profile referenced by connections via `sshProfile`. */
export const sshProfileSchema = z
  .strictObject({
    name: z.string().min(1, 'SSH 配置名不能为空'),
    host: z.string().min(1, 'SSH host 不能为空'),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().min(1, 'SSH username 不能为空'),
    auth: sshAuthSchema,
    /** known_hosts 文件路径；缺省用 ~/.ssh/known_hosts。校验为严格模式（必须已存在）。 */
    knownHostsPath: z.string().min(1).optional(),
    readyTimeoutMs: z.number().int().min(1000).max(120000).optional(),
    keepaliveIntervalMs: z.number().int().min(0).max(300000).optional(),
    /** FR-22: read-only log sources exposed to the model tools. */
    logSources: z.array(sshLogSourceSchema).max(MAX_LOG_SOURCES_PER_PROFILE, `单个 SSH 配置最多 ${MAX_LOG_SOURCES_PER_PROFILE} 个日志源`).optional(),
  })
  .superRefine((value, ctx) => {
    const sources = value.logSources ?? []
    const seen = new Set<string>()
    sources.forEach((source, index) => {
      if (seen.has(source.name)) {
        ctx.addIssue({ code: 'custom', path: ['logSources', index, 'name'], message: `日志源名 "${source.name}" 重复` })
      }
      seen.add(source.name)
      // `via` names a second hop; pointing it at this same profile would mean
      // "read the jump host's own log through itself" — almost always a typo.
      if (source.via !== undefined && source.via === value.name) {
        ctx.addIssue({ code: 'custom', path: ['logSources', index, 'via'], message: 'via 不能指向当前 SSH 配置自身' })
      }
    })
  })

export type SshProfileInput = z.infer<typeof sshProfileSchema>

/**
 * One connection, with a per-dialect discriminated shape. MySQL and PostgreSQL
 * share one schema (same field set, only the literal `dialect` differs); SQLite
 * has its own shape — only `file` is required, all server-style fields are
 * absent so the user gets immediate feedback when they try to mix them.
 *
 * Old configurations written before the dialect field was introduced (i.e.
 * `{ name, host, port, username, password, ... }` with no `dialect`) stay
 * accepted via a preprocess step that defaults `dialect` to 'mysql'. This is
 * the backward-compatibility hook of the multi-dialect extension.
 */
export const connectionSchema = z.preprocess(
  (value) => {
    if (typeof value === 'object' && value !== null && !('dialect' in (value as Record<string, unknown>))) {
      return { ...(value as Record<string, unknown>), dialect: 'mysql' }
    }
    return value
  },
  z.discriminatedUnion('dialect', [mysqlLikeSchema, sqliteSchema]),
)

export type ConnectionInput = z.infer<typeof connectionSchema>

export const globalConfigSchema = z.strictObject({
  connections: z.array(connectionSchema).default([]),
  sshProfiles: z.array(sshProfileSchema).default([]),
})

export const workspaceConfigSchema = z.strictObject({
  connections: z.array(connectionSchema).default([]),
  sshProfiles: z.array(sshProfileSchema).default([]),
  useGlobal: z.array(z.string()).default([]),
  default: z.string().min(1).optional(),
})

export type GlobalConfig = z.infer<typeof globalConfigSchema>
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>

/** Format zod issues as one readable line per problem. */
export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(根)'
    return `${where}: ${issue.message}`
  })
}
