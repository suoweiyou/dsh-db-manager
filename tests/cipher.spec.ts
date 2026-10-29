import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decryptFromSecret, describePasswordIssue, encryptToSecret, parsePasswordSecret, resolvePassword, SecretError } from '../src/secrets.js'

const tempDirs: string[] = []
function tempKeyPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dbm-key-`))
  tempDirs.push(dir)
  return path.join(dir, 'secret.key')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('cipher roundtrip', () => {
  it('encrypts to enc:v1 form and decrypts back', () => {
    const keyPath = tempKeyPath()
    const secret = encryptToSecret('p@ssw0rd-密码', keyPath)
    expect(secret.startsWith('enc:v1:')).toBe(true)
    expect(decryptFromSecret(secret, keyPath)).toBe('p@ssw0rd-密码')
  })

  it('fails decryption with a different key', () => {
    const keyA = tempKeyPath()
    const keyB = tempKeyPath()
    const secret = encryptToSecret('secret', keyA)
    expect(() => decryptFromSecret(secret, keyB)).toThrow(SecretError)
  })
})

describe('parsePasswordSecret', () => {
  it('parses $ENV references', () => {
    expect(parsePasswordSecret('$ENV:MYSQL_PW')).toEqual({ kind: 'env', varName: 'MYSQL_PW' })
  })

  it('rejects malformed env references', () => {
    expect(() => parsePasswordSecret('$ENV:9BAD')).toThrow(SecretError)
    expect(() => parsePasswordSecret('$ENV:')).toThrow(SecretError)
  })

  it('parses enc:v1 ciphertext', () => {
    const secret = encryptToSecret('x', tempKeyPath())
    expect(parsePasswordSecret(secret).kind).toBe('enc')
  })

  it('rejects plaintext with an actionable message', () => {
    try {
      parsePasswordSecret('super-secret')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(SecretError)
      expect((error as SecretError).message).toContain('不允许明文')
      expect((error as SecretError).hint).toContain('bin/encrypt.js')
    }
  })
})

describe('resolvePassword', () => {
  it('reads from the provided environment', () => {
    expect(resolvePassword('$ENV:TEST_DB_PW', { TEST_DB_PW: 'hello' }, './nonexistent-key')).toBe('hello')
  })

  it('reports a missing environment variable with its name', () => {
    try {
      resolvePassword('$ENV:MISSING_VAR_XYZ', {}, './nonexistent-key')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as SecretError).message).toContain('MISSING_VAR_XYZ')
    }
  })
})

describe('describePasswordIssue', () => {
  it('returns undefined for resolvable secrets', () => {
    expect(describePasswordIssue('$ENV:TEST_DB_PW', { TEST_DB_PW: 'x' })).toBeUndefined()
  })

  it('returns a readable issue for missing env vars and plaintext', () => {
    expect(describePasswordIssue('$ENV:MISSING_VAR_XYZ', {})).toContain('MISSING_VAR_XYZ')
    expect(describePasswordIssue('plain', {})).toContain('不允许明文')
  })
})
