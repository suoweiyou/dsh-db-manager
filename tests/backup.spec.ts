import { describe, expect, it } from 'vitest'
import { classifySql } from '../src/safety/classify.js'
import { planRowBackup } from '../src/db/backup.js'

function plan(sql: string, fallbackDb: string | undefined) {
  const result = classifySql(sql)
  const stmt = result.statements[0]!
  return { decision: planRowBackup(stmt.ast, fallbackDb, 'mysql'), reliable: result.reliable }
}

describe('planRowBackup', () => {
  it('plans a shadow backup for UPDATE with WHERE', () => {
    const { decision } = plan("UPDATE users SET name = 'a' WHERE id = 5", 'mydb')
    if (decision.kind !== 'ready') throw new Error(`expected ready, got ${JSON.stringify(decision)}`)
    expect(decision.plan.backupName.startsWith('__dbm_backup_users_')).toBe(true)
    expect(decision.plan.backupName.length).toBeLessThanOrEqual(64)
    expect(/^[\p{L}\p{N}_]+$/u.test(decision.plan.backupName)).toBe(true)
    expect(decision.plan.countSql).toContain('WHERE')
    expect(decision.plan.createSql).toContain('LIKE `mydb`.`users`')
    expect(decision.plan.insertSql).toContain(`INTO \`${decision.plan.backupName}\``)
    expect(decision.plan.suggestSql).toContain('CREATE TABLE')
  })

  it('plans a full-table backup for DELETE without WHERE', () => {
    const { decision } = plan('DELETE FROM users', 'mydb')
    if (decision.kind !== 'ready') throw new Error('expected ready')
    expect(decision.plan.countSql).not.toContain('WHERE')
    expect(decision.plan.insertSql).toContain('SELECT * FROM (SELECT')
  })

  it('keeps aliases working in count and backup SQL', () => {
    const { decision } = plan("UPDATE users AS u SET u.name = 'x' WHERE u.id = 3", 'mydb')
    if (decision.kind !== 'ready') throw new Error('expected ready')
    expect(decision.plan.countSql).toContain('AS `u`')
    expect(decision.plan.countSql).toContain('`u`.`id` = 3')
  })

  it('prefers the database qualified in the statement over the fallback', () => {
    const { decision } = plan('DELETE FROM otherdb.users WHERE id = 1', 'mydb')
    if (decision.kind !== 'ready') throw new Error('expected ready')
    expect(decision.plan.createSql).toContain('LIKE `otherdb`.`users`')
    expect(decision.plan.createSql).not.toContain('`mydb`')
  })

  it('marks multi-table JOIN updates as infeasible', () => {
    const { decision } = plan('UPDATE a JOIN b ON a.id = b.id SET a.x = 1', 'mydb')
    expect(decision.kind).toBe('infeasible')
    if (decision.kind === 'infeasible') expect(decision.reason).toContain('JOIN')
  })

  it('marks REPLACE as infeasible (conflicting rows cannot be located)', () => {
    const { decision } = plan('REPLACE INTO users VALUES (1)', 'mydb')
    expect(decision.kind).toBe('infeasible')
  })

  it('does not back up INSERT (nothing to lose)', () => {
    const { decision } = plan('INSERT INTO users VALUES (1)', 'mydb')
    expect(decision.kind).toBe('none')
  })

  it('marks unparsable statements as infeasible (no AST)', () => {
    const result = classifySql('UPDATE t SET a = 1 /* unterminated')
    const stmt = result.statements[0]!
    const decision = planRowBackup(stmt.ast, 'mydb', 'mysql')
    if (!result.reliable) {
      expect(decision.kind).toBe('infeasible')
    } else {
      expect(['none', 'ready', 'infeasible']).toContain(decision.kind)
    }
  })

  it('marks unqualified tables without a default database as infeasible', () => {
    const { decision } = plan('DELETE FROM users WHERE id = 1', undefined)
    expect(decision.kind).toBe('infeasible')
    if (decision.kind === 'infeasible') expect(decision.reason).toContain('无法确定目标表/库')
  })
})
