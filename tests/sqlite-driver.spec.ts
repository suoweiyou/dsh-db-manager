/**
 * SQLite driver unit tests (dialect-specific surface; no real database file).
 * Exercises the SQLite error-code mapping, the SQLite shadow-backup SQL
 * (CREATE TABLE … AS SELECT WHERE 0), and the classifySql path for the
 * sqlite dialect. Real-database integration coverage lives in
 * tests/integration/sqlite.spec.ts (skipped unless SQLite is available).
 */
import { describe, expect, it } from 'vitest'
import { classifySql } from '../src/safety/classify.js'
import { planRowBackup } from '../src/db/backup.js'
import { classifyDbError, kindLabel } from '../src/db/errors.js'

describe('classifySql — SQLite dialect', () => {
  it('classifies a SELECT as read', () => {
    const result = classifySql('SELECT id FROM t WHERE id = ?', 'sqlite')
    expect(result.reliable).toBe(true)
    expect(result.statements).toHaveLength(1)
    expect(result.statements[0]?.kind).toBe('read')
    expect(result.statements[0]?.dangerous).toBe(false)
  })

  it('still flags UPDATE/DELETE without WHERE as dangerous', () => {
    const result = classifySql('UPDATE t SET x = 1', 'sqlite')
    expect(result.reliable).toBe(true)
    expect(result.statements[0]?.kind).toBe('write')
    expect(result.statements[0]?.dangerous).toBe(true)
  })
})

describe('planRowBackup — SQLite', () => {
  function plan(sql: string, fallbackDb: string | undefined) {
    const result = classifySql(sql, 'sqlite')
    const stmt = result.statements[0]!
    return planRowBackup(stmt.ast, fallbackDb, 'sqlite')
  }

  it('uses CREATE TABLE … AS SELECT WHERE 0 (SQLite has no LIKE syntax)', () => {
    const decision = plan('UPDATE users SET name = ? WHERE id = ?', 'mydb')
    if (decision.kind !== 'ready') throw new Error(`expected ready, got ${JSON.stringify(decision)}`)
    expect(decision.plan.createSql).toContain('CREATE TABLE `__dbm_backup_users_')
    expect(decision.plan.createSql).toContain('AS SELECT * FROM')
    expect(decision.plan.createSql).toContain('WHERE 0')
    expect(decision.plan.createSql.startsWith('CREATE TABLE `')).toBe(true)
    expect(decision.plan.insertSql).toContain(`INTO \`${decision.plan.backupName}\``)
  })

  it('INSERT is none (no rows to lose)', () => {
    const decision = plan('INSERT INTO users VALUES (?)', 'mydb')
    expect(decision.kind).toBe('none')
  })

  it('multi-table UPDATE is infeasible', () => {
    const decision = plan('UPDATE a SET x = 1 FROM b WHERE a.id = b.id', 'mydb')
    expect(decision.kind).toBe('infeasible')
  })
})

describe('classifyDbError — SQLite result codes', () => {
  it('SQLITE_BUSY → timeout (lock wait)', () => {
    const f = classifyDbError({ code: 'SQLITE_BUSY', message: 'database is locked' })
    expect(f.kind).toBe('timeout')
    expect(kindLabel(f.kind)).toBe('连接超时')
  })

  it('SQLITE_CANTOPEN → config (file path / permissions)', () => {
    const f = classifyDbError({ code: 'SQLITE_CANTOPEN', message: 'unable to open database file' })
    expect(f.kind).toBe('config')
  })

  it('SQLITE_NOTADB → config (file exists but is not a SQLite database)', () => {
    const f = classifyDbError({ code: 'SQLITE_NOTADB', message: 'file is not a database' })
    expect(f.kind).toBe('config')
  })

  it('SQLITE_READONLY → config (write attempt on a read-only file)', () => {
    const f = classifyDbError({ code: 'SQLITE_READONLY', message: 'attempt to write a readonly database' })
    expect(f.kind).toBe('config')
  })

  it('SQLITE_AUTH / SQLITE_PERM → permission', () => {
    expect(classifyDbError({ code: 'SQLITE_AUTH', message: 'not authorized' }).kind).toBe('permission')
    expect(classifyDbError({ code: 'SQLITE_PERM', message: 'access permission denied' }).kind).toBe('permission')
  })

  it('SQLITE_CONSTRAINT / SQLITE_MISMATCH / SQLITE_RANGE / SQLITE_MISUSE / SQLITE_ERROR → syntax', () => {
    for (const code of ['SQLITE_CONSTRAINT', 'SQLITE_MISMATCH', 'SQLITE_RANGE', 'SQLITE_MISUSE', 'SQLITE_ERROR']) {
      const f = classifyDbError({ code, message: `${code} something` })
      expect(f.kind, code).toBe('syntax')
    }
  })

  it('unknown SQLite codes fall through to unknown', () => {
    const f = classifyDbError({ code: 'SQLITE_FULL', message: 'database or disk is full' })
    expect(f.kind).toBe('unknown')
  })
})
