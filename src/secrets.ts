/**
 * Password secret handling: `$ENV:VAR` references and AES-256-GCM ciphertext
 * (`enc:v1:iv:tag:cipher`, base64url). Plaintext passwords are rejected at the
 * schema layer; the ciphertext form is produced offline via bin/encrypt.js so
 * secrets never travel through model context.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const ENV_PREFIX = '$ENV:'
export const ENC_PREFIX = 'enc:v1:'

export type PasswordSecret =
  | { kind: 'env'; varName: string }
  | { kind: 'enc'; iv: Buffer; tag: Buffer; data: Buffer }

export class SecretError extends Error {
  readonly hint?: string
  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'SecretError'
    this.hint = hint
  }
}

/** Directory holding the key file and global config (honours DSH_HOME). */
export function globalDir(): string {
  const base = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(base, 'db-manager')
}

export function defaultKeyPath(): string {
  return path.join(globalDir(), 'secret.key')
}

/** Parse the stored password string into a structured secret (no IO). */
export function parsePasswordSecret(raw: string): PasswordSecret {
  if (raw.startsWith(ENV_PREFIX)) {
    const varName = raw.slice(ENV_PREFIX.length).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
      // Never echo any fragment of the stored value: when the field holds an
      // accidental plaintext password the error previously leaked its first
      // characters into tool output, GUI warnings and the audit log (audit M2).
      throw new SecretError('非法的密码环境变量引用：应为 "$ENV:VAR_NAME" 形式（变量名仅限字母、数字与下划线；若此处填写的是明文密码，请改用密文形式）')
    }
    return { kind: 'env', varName }
  }
  if (raw.startsWith(ENC_PREFIX)) {
    const parts = raw.slice(ENC_PREFIX.length).split(':')
    if (parts.length !== 3) {
      throw new SecretError('非法的密文密码：应为 enc:v1:<iv>:<tag>:<cipher>（base64url 三段）', '用 node bin/encrypt.js 重新生成密文')
    }
    try {
      const iv = Buffer.from(parts[0]!, 'base64url')
      const tag = Buffer.from(parts[1]!, 'base64url')
      const data = Buffer.from(parts[2]!, 'base64url')
      if (iv.length !== 12 || tag.length !== 16) throw new Error('bad lengths')
      return { kind: 'enc', iv, tag, data }
    } catch {
      throw new SecretError('非法的密文密码：base64url 解码失败或长度不符', '用 node bin/encrypt.js 重新生成密文')
    }
  }
  throw new SecretError(
    '密码字段不允许明文：请改用 "$ENV:VAR_NAME" 环境变量引用，或用密文形式',
    '在终端运行 node bin/encrypt.js 交互生成 enc:v1:… 密文后粘贴到配置文件',
  )
}

/** Load the 32-byte local key file, creating it on first use (mode 0600 best effort). */
export function loadOrCreateKey(keyPath: string): Buffer {
  let existing: Buffer | undefined
  try {
    existing = fs.readFileSync(keyPath)
  } catch {
    existing = undefined
  }
  if (existing !== undefined) {
    if (existing.length === 32) return existing
    // Never silently rotate: a corrupted key file must fail loudly, otherwise
    // every stored ciphertext would become undecryptable by surprise.
    throw new SecretError(
      `密钥文件损坏（长度 ${existing.length}，应为 32 字节）：${keyPath}`,
      '确认旧密文不再需要后，备份并删除该文件以重建新密钥；已有 enc:v1 密文需用 bin/encrypt.js 重新生成，或改用 $ENV:VAR 形式',
    )
  }
  const key = randomBytes(32)
  fs.mkdirSync(path.dirname(keyPath), { recursive: true })
  try {
    fs.writeFileSync(keyPath, key, { mode: 0o600 })
  } catch {
    fs.writeFileSync(keyPath, key)
  }
  return key
}

/** Encrypt one plaintext secret into the `enc:v1:...` on-disk form. */
export function encryptToSecret(plain: string, keyPath: string = defaultKeyPath()): string {
  const key = loadOrCreateKey(keyPath)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${data.toString('base64url')}`
}

/** Decrypt one `enc:v1:...` string with the local key file. */
export function decryptFromSecret(raw: string, keyPath: string = defaultKeyPath()): string {
  const secret = parsePasswordSecret(raw)
  if (secret.kind !== 'enc') throw new SecretError('不是密文形式的密码')
  const key = loadOrCreateKey(keyPath)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, secret.iv)
    decipher.setAuthTag(secret.tag)
    return Buffer.concat([decipher.update(secret.data), decipher.final()]).toString('utf8')
  } catch {
    throw new SecretError('密文解密失败：密文与本机密钥不匹配（密文绑定生成它的那台机器）', '重新用 bin/encrypt.js 在本机生成密文，或改用 $ENV:VAR 形式')
  }
}

/** Resolve a stored password string to plaintext (env lookup or decryption). */
export function resolvePassword(raw: string, env: NodeJS.ProcessEnv = process.env, keyPath: string = defaultKeyPath()): string {
  const secret = parsePasswordSecret(raw)
  if (secret.kind === 'env') {
    const value = env[secret.varName]
    if (value === undefined || value === '') {
      throw new SecretError(`环境变量 ${secret.varName} 未设置，无法解析连接密码`, `设置环境变量 ${secret.varName} 后重启 DSH 生效`)
    }
    return value
  }
  return decryptFromSecret(raw, keyPath)
}

/** Cheap availability probe: returns a readable issue message, or undefined when resolvable. */
export function describePasswordIssue(raw: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const secret = parsePasswordSecret(raw)
    if (secret.kind === 'env' && (env[secret.varName] === undefined || env[secret.varName] === '')) {
      return `环境变量 ${secret.varName} 未设置`
    }
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
