import { describe, expect, it } from 'vitest'
import { classifyDbError } from '../src/db/errors.js'

describe('classifyDbError', () => {
  const cases: Array<[string, string]> = [
    ['ECONNREFUSED', 'network'],
    ['ENOTFOUND', 'network'],
    ['ETIMEDOUT', 'timeout'],
    ['PROTOCOL_SEQUENCE_TIMEOUT', 'timeout'],
    ['ER_ACCESS_DENIED_ERROR', 'auth'],
    ['ER_BAD_DB_ERROR', 'unknown-database'],
    ['ER_DBACCESS_DENIED_ERROR', 'permission'],
    ['ER_PARSE_ERROR', 'syntax'],
  ]

  for (const [code, kind] of cases) {
    it(`maps ${code} to ${kind}`, () => {
      const failure = classifyDbError({ code, message: `boom (${code})` })
      expect(failure.kind).toBe(kind)
      expect(failure.message).toContain('boom')
      expect(failure.hint).toBeTruthy()
    })
  }

  it('falls back to unknown for unrecognized errors', () => {
    expect(classifyDbError(new Error('weird')).kind).toBe('unknown')
  })

  it('discloses that client-side inactivity timeouts may still run server-side (audit M7)', () => {
    const failure = classifyDbError({ code: 'PROTOCOL_SEQUENCE_TIMEOUT', message: 'Query inactivity timeout' })
    expect(failure.kind).toBe('timeout')
    expect(failure.message).toContain('服务器端')
    expect(failure.hint).toContain('KILL')
  })
})
