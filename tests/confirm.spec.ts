import { describe, expect, it } from 'vitest'
import { issueConfirmToken, verifyConfirmToken } from '../src/safety/confirm.js'

describe('confirm tokens', () => {
  it('verifies a freshly issued token for the same connection+sql', () => {
    const issued = issueConfirmToken('conn-a', 'DROP TABLE t')
    expect(verifyConfirmToken(issued.confirmToken, 'conn-a', 'DROP TABLE t').ok).toBe(true)
  })

  it('enforces single use: the same token cannot execute twice', () => {
    const issued = issueConfirmToken('conn-a', 'DROP TABLE t2')
    expect(verifyConfirmToken(issued.confirmToken, 'conn-a', 'DROP TABLE t2').ok).toBe(true)
    const second = verifyConfirmToken(issued.confirmToken, 'conn-a', 'DROP TABLE t2')
    expect(second.ok).toBe(false)
    expect(second.reason).toContain('已被使用')
  })

  it('rejects a token bound to a different statement', () => {
    const issued = issueConfirmToken('conn-a', 'DROP TABLE t')
    expect(verifyConfirmToken(issued.confirmToken, 'conn-a', 'DROP TABLE other').ok).toBe(false)
  })

  it('rejects a token bound to a different connection', () => {
    const issued = issueConfirmToken('conn-a', 'DROP TABLE t')
    expect(verifyConfirmToken(issued.confirmToken, 'conn-b', 'DROP TABLE t').ok).toBe(false)
  })

  it('rejects expired tokens', () => {
    const issued = issueConfirmToken('conn-a', 'DROP TABLE t', Date.now() - 6 * 60_000)
    const verdict = verifyConfirmToken(issued.confirmToken, 'conn-a', 'DROP TABLE t')
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('过期')
  })

  it('rejects malformed tokens', () => {
    expect(verifyConfirmToken(undefined, 'c', 'sql').ok).toBe(false)
    expect(verifyConfirmToken('', 'c', 'sql').ok).toBe(false)
    expect(verifyConfirmToken('not-a-token', 'c', 'sql').ok).toBe(false)
    expect(verifyConfirmToken('abc.def', 'c', 'sql').ok).toBe(false)
  })
})
