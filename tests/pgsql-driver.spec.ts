/**
 * PostgreSQL driver unit tests (dialect-specific surface; no real connection).
 * Exercises the `?` → `$N` rewrite, the pgsql backup SQL, and the SQLSTATE →
 * DbErrorKind mapping. Real-database integration coverage lives in
 * tests/integration/pgsql.spec.ts and only runs when PGSQL_TEST_URL is set.
 */
import { describe, expect, it } from 'vitest'
import { classifySql } from '../src/safety/classify.js'
import { planRowBackup } from '../src/db/backup.js'
import { classifyDbError, kindLabel } from '../src/db/errors.js'
import { pgsqlPlaceholderRewrite } from '../src/db/pgsql-driver.js'
import { resolvePgSchemaValue } from '../src/db/metadata.js'

describe('resolvePgSchemaValue — DATABASE vs SCHEMA role split', () => {
  it('maps an empty/unset parameter to the public schema', () => {
    expect(resolvePgSchemaValue(undefined, 'myapp')).toBe('public')
    expect(resolvePgSchemaValue('', 'myapp')).toBe('public')
    expect(resolvePgSchemaValue('   ', 'myapp')).toBe('public')
  })

  it('maps a parameter equal to the current database name to public (the connection bound DB is NOT the schema)', () => {
    expect(resolvePgSchemaValue('myapp', 'myapp')).toBe('public')
  })

  it('keeps an explicit non-current schema name unchanged', () => {
    expect(resolvePgSchemaValue('other_schema', 'myapp')).toBe('other_schema')
  })

  it('falls back to public when the current database cannot be determined and the parameter is empty', () => {
    expect(resolvePgSchemaValue('', undefined)).toBe('public')
    expect(resolvePgSchemaValue(undefined, undefined)).toBe('public')
  })
})

describe('pgsqlPlaceholderRewrite', () => {
  it('rewrites a single ? placeholder', () => {
    expect(pgsqlPlaceholderRewrite('SELECT 1 FROM t WHERE id = ?')).toBe('SELECT 1 FROM t WHERE id = $1')
  })

  it('numbers placeholders in left-to-right order', () => {
    expect(pgsqlPlaceholderRewrite('SELECT * FROM t WHERE a = ? AND b = ? OR c = ?')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2 OR c = $3',
    )
  })

  it('skips placeholders inside single- or double-quoted strings', () => {
    expect(pgsqlPlaceholderRewrite("SELECT 'a ? b', \"c ? d\", ? FROM t")).toBe(
      "SELECT 'a ? b', \"c ? d\", $1 FROM t",
    )
  })

  it('escapes a doubled quote and still skips the following chars', () => {
    expect(pgsqlPlaceholderRewrite("SELECT 'it''s ? fine', ? FROM t")).toBe(
      "SELECT 'it''s ? fine', $1 FROM t",
    )
  })

  it('skips placeholders inside line comments', () => {
    expect(pgsqlPlaceholderRewrite('SELECT 1 -- a ?\nFROM t WHERE id = ?')).toBe(
      'SELECT 1 -- a ?\nFROM t WHERE id = $1',
    )
  })

  it('skips placeholders inside /* */ block comments', () => {
    expect(pgsqlPlaceholderRewrite('SELECT 1 /* a ? */ FROM t WHERE id = ?')).toBe(
      'SELECT 1 /* a ? */ FROM t WHERE id = $1',
    )
  })
})

describe('classifySql — PostgreSQL dialect', () => {
  it('classifies a SELECT as read', () => {
    const result = classifySql('SELECT id FROM t WHERE id = $1', 'postgresql')
    expect(result.reliable).toBe(true)
    expect(result.statements).toHaveLength(1)
    expect(result.statements[0]?.kind).toBe('read')
    expect(result.statements[0]?.dangerous).toBe(false)
  })

  it('rejects EXPLAIN of a write/DDL as unknown (audit M-series parity)', () => {
    const result = classifySql('EXPLAIN UPDATE t SET x = 1', 'postgresql')
    // node-sql-parser may fail outright on PG EXPLAIN (reliable=false, regex
    // fallback) or produce an AST whose EXPLAIN wraps a non-read statement
    // (reliable=true, kind=unknown). Both paths refuse execution; assert
    // the safety invariants without pinning which path was taken.
    expect(result.statements[0]?.kind).toBe('unknown')
    expect(result.statements[0]?.dangerous).toBe(true)
  })

  it('still flags UPDATE/DELETE without WHERE as dangerous', () => {
    const result = classifySql('UPDATE t SET x = 1', 'postgresql')
    expect(result.reliable).toBe(true)
    expect(result.statements[0]?.kind).toBe('write')
    expect(result.statements[0]?.dangerous).toBe(true)
  })
})

describe('planRowBackup — PostgreSQL', () => {
  function plan(sql: string, fallbackDb: string | undefined) {
    const result = classifySql(sql, 'postgresql')
    const stmt = result.statements[0]!
    return planRowBackup(stmt.ast, fallbackDb, 'postgresql')
  }

  it('plans a shadow backup for UPDATE with the PG (LIKE ... INCLUDING ALL) syntax', () => {
    const decision = plan('UPDATE users SET name = $1 WHERE id = $2', 'mydb')
    if (decision.kind !== 'ready') throw new Error(`expected ready, got ${JSON.stringify(decision)}`)
    expect(decision.plan.backupName.startsWith('__dbm_backup_users_')).toBe(true)
    // PG quoting uses double quotes around the schema.table reference.
    expect(decision.plan.createSql).toContain('LIKE "mydb"."users"')
    expect(decision.plan.createSql).toContain('INCLUDING ALL')
    expect(decision.plan.createSql.startsWith('CREATE TABLE "')).toBe(true)
    expect(decision.plan.insertSql).toContain(`INTO "${decision.plan.backupName}"`)
  })

  it('INSERT is none (no rows to lose)', () => {
    const decision = plan('INSERT INTO users VALUES ($1)', 'mydb')
    expect(decision.kind).toBe('none')
  })

  it('multi-table UPDATE is infeasible', () => {
    const decision = plan('UPDATE a SET x = 1 FROM b WHERE a.id = b.id', 'mydb')
    expect(decision.kind).toBe('infeasible')
  })

  it('REPLACE is infeasible (PG never parses REPLACE — its AST node is unknown here)', () => {
    // node-sql-parser does not model PG INSERT ... ON CONFLICT as 'replace',
    // so the planner's REPLACE branch is only reachable from MySQL connections.
    // This test documents that the PG path stays consistent: REPLACE never
    // produces a plan because PG would have parsed it as an unknown shape.
    const decision = plan('INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET x = 1', 'mydb')
    expect(['none', 'infeasible']).toContain(decision.kind)
  })
})

describe('classifyDbError — PostgreSQL SQLSTATE', () => {
  it('28P01 → auth', () => {
    const f = classifyDbError({ code: '28P01', message: 'password authentication failed for user "u"' })
    expect(f.kind).toBe('auth')
    expect(kindLabel(f.kind)).toBe('认证失败')
  })

  it('3D000 → unknown-database', () => {
    const f = classifyDbError({ code: '3D000', message: 'database "nope" does not exist' })
    expect(f.kind).toBe('unknown-database')
  })

  it('3F000 → unknown-database (invalid schema)', () => {
    const f = classifyDbError({ code: '3F000', message: 'schema "nope" does not exist' })
    expect(f.kind).toBe('unknown-database')
  })

  it('42601 → syntax', () => {
    const f = classifyDbError({ code: '42601', message: 'syntax error at or near "WHERE"' })
    expect(f.kind).toBe('syntax')
  })

  it('42501 → permission (sufficient_privilege)', () => {
    const f = classifyDbError({ code: '42501', message: 'permission denied for table users' })
    expect(f.kind).toBe('permission')
  })

  it('network errors keep their kind even though they are not SQLSTATE', () => {
    const f = classifyDbError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:5432' })
    expect(f.kind).toBe('network')
  })
})
