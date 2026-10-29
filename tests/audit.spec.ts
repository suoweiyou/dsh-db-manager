import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuditLog, sanitizeSql } from '../src/audit/log.js'

const dirs: string[] = []
function makeAudit(enabled = true): AuditLog {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-audit-'))
  dirs.push(dir)
  return new AuditLog({ dir, enabled })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('sanitizeSql', () => {
  it('collapses whitespace, strips credential fragments, clamps length', () => {
    const sql = 'SELECT *\n  FROM t WHERE p = "$ENV:SECRET_PW" AND q = "enc:v1:aaa:bbb:ccc"'
    const sanitized = sanitizeSql(sql)
    expect(sanitized).not.toContain('$ENV:SECRET_PW')
    expect(sanitized).toContain('$ENV:***')
    expect(sanitized).toContain('enc:v1:***')
    expect(sanitizeSql('x'.repeat(3000)).length).toBeLessThan(2200)
  })

  it('masks literal credentials embedded in DDL/DCL statements (audit M3)', () => {
    const sanitized = sanitizeSql("CREATE USER 'app'@'%' IDENTIFIED BY 'Sup3rSecret!'; SET PASSWORD = PASSWORD('abc')")
    expect(sanitized).not.toContain('Sup3rSecret!')
    expect(sanitized).not.toContain("'abc'")
    expect(sanitized).toContain("IDENTIFIED BY '***'")
    expect(sanitized).toContain("PASSWORD('***')")
    expect(sanitizeSql('ALTER USER u IDENTIFIED BY "pwd"')).toContain('IDENTIFIED BY "***"')
    expect(sanitizeSql("SET PASSWORD FOR 'u'@'%' = 'plain'")).toContain("SET PASSWORD = '***'")
  })
})

describe('AuditLog', () => {
  it('appends JSONL entries to the day file', async () => {
    const audit = makeAudit(true)
    audit.record({ ts: 1, channel: 'tool', action: 'db_query', status: 'ok', rowCount: 3, sql: 'SELECT 1' })
    audit.record({ ts: 2, channel: 'rpc', action: 'connections.save', status: 'ok', connection: 'a' })
    await audit.flush()
    const files = fs.readdirSync(audit.dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/)
    const lines = fs.readFileSync(`${audit.dir}/${files[0]}`, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ channel: 'tool', action: 'db_query', status: 'ok', rowCount: 3 })
    expect(lines[1]).toMatchObject({ channel: 'rpc', action: 'connections.save', connection: 'a' })
  })

  it('is a no-op when disabled', async () => {
    const audit = makeAudit(false)
    audit.record({ ts: 1, channel: 'tool', action: 'db_query', status: 'ok' })
    await audit.flush()
    const files = fs.existsSync(audit.dir) ? fs.readdirSync(audit.dir) : []
    expect(files.some((f) => f.endsWith('.jsonl'))).toBe(false)
  })

  it('prunes files older than the retention window', () => {
    const audit = makeAudit(true)
    fs.mkdirSync(audit.dir, { recursive: true })
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}`
    fs.writeFileSync(`${audit.dir}/${stamp}.jsonl`, '{}\n', 'utf8')
    fs.writeFileSync(`${audit.dir}/not-audit.txt`, 'keep', 'utf8')
    const removed = audit.prune(new Date())
    expect(removed).toBe(1)
    expect(fs.existsSync(`${audit.dir}/${stamp}.jsonl`)).toBe(false)
    expect(fs.existsSync(`${audit.dir}/not-audit.txt`)).toBe(true)
  })

  it('prunes inside the write path once per day', async () => {
    const audit = makeAudit(true)
    fs.mkdirSync(audit.dir, { recursive: true })
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
    const pad = (n: number) => String(n).padStart(2, '0')
    const oldFile = `${audit.dir}/${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}.jsonl`
    fs.writeFileSync(oldFile, '{}\n', 'utf8')
    audit.record({ ts: Date.now(), channel: 'tool', action: 'db_test_connection', status: 'ok' })
    await audit.flush()
    expect(fs.readdirSync(audit.dir).some((f) => f.endsWith('.jsonl'))).toBe(true)
    expect(fs.existsSync(oldFile)).toBe(false)
  })
})
