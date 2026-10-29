/**
 * One-shot confirmation tokens for dangerous statements. A token HMAC-binds
 * the target connection name and the exact SQL text with an expiry, so a
 * stale or replayed token cannot authorize a different statement.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const TTL_MS = 5 * 60_000
const secret = randomBytes(32)
/** Consumed tokens: single-use enforcement (PRD FR-9 拒绝重放/复用). */
const usedTokens = new Set<string>()
const USED_PRUNE_THRESHOLD = 512

export interface ConfirmIssue {
  confirmToken: string
  expiresAt: number
}

function signature(connectionName: string, sql: string, expiresAt: number): string {
  const sqlHash = createHash('sha256').update(sql, 'utf8').digest('hex')
  return createHmac('sha256', secret).update(`${connectionName}\n${sqlHash}\n${expiresAt}`).digest('base64url')
}

export function issueConfirmToken(connectionName: string, sql: string, now = Date.now()): ConfirmIssue {
  const expiresAt = now + TTL_MS
  return { confirmToken: `${expiresAt}.${signature(connectionName, sql, expiresAt)}`, expiresAt }
}

export function verifyConfirmToken(token: unknown, connectionName: string, sql: string, now = Date.now()): { ok: boolean; reason?: string } {
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: '缺少确认令牌' }
  const dot = token.indexOf('.')
  if (dot <= 0) return { ok: false, reason: '确认令牌格式不正确' }
  const expiresPart = token.slice(0, dot)
  const sigPart = token.slice(dot + 1)
  const expiresAt = Number.parseInt(expiresPart, 10)
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: '确认令牌格式不正确' }
  if (expiresAt < now) return { ok: false, reason: '确认令牌已过期（有效期 5 分钟），请重新发起执行以获取新令牌' }
  const expected = signature(connectionName, sql, expiresAt)
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(sigPart, 'utf8')
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: '确认令牌与当前连接/语句不匹配（令牌绑定单条语句）' }
  }
  if (usedTokens.has(token)) {
    return { ok: false, reason: '确认令牌已被使用（一次性令牌），请重新发起执行以获取新令牌' }
  }
  // Bound the ledger; expired tokens age out anyway.
  if (usedTokens.size >= USED_PRUNE_THRESHOLD) {
    for (const used of usedTokens) {
      const usedExpiry = Number.parseInt(used.slice(0, used.indexOf('.')), 10)
      if (!Number.isFinite(usedExpiry) || usedExpiry < now) usedTokens.delete(used)
    }
  }
  usedTokens.add(token)
  return { ok: true }
}
