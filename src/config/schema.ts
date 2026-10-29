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

/** One reusable SSH (jump host) profile referenced by connections via `sshProfile`. */
export const sshProfileSchema = z.strictObject({
  name: z.string().min(1, 'SSH 配置名不能为空'),
  host: z.string().min(1, 'SSH host 不能为空'),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1, 'SSH username 不能为空'),
  auth: sshAuthSchema,
  /** known_hosts 文件路径；缺省用 ~/.ssh/known_hosts。校验为严格模式（必须已存在）。 */
  knownHostsPath: z.string().min(1).optional(),
  readyTimeoutMs: z.number().int().min(1000).max(120000).optional(),
  keepaliveIntervalMs: z.number().int().min(0).max(300000).optional(),
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
