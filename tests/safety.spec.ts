import { describe, expect, it } from 'vitest'
import { classifySql, explainInnerIsRead, injectReadLimit, isReadonlyBatch } from '../src/safety/classify.js'

// Regression: the executed text must always be the caller's own statement.
// node-sql-parser's sqlify ignores the `type` option for identifier quoting
// (emits MySQL backticks under `type: postgresql`), so using its output as the
// execution text made every parseable PostgreSQL query fail with
// `syntax error at or near "\`"`. sqlify output now lives in `normalized` and
// serves the round-trip safety cross-check only.
describe('statement text vs parser regeneration (PostgreSQL query regression)', () => {
  it('postgresql: keeps the original text for an ordinary parseable SELECT', () => {
    const stmt = classifySql('select 1 as one', 'postgresql').statements[0]!
    expect(stmt.kind).toBe('read')
    expect(stmt.reliable).toBe(true)
    expect(stmt.statement).toBe('select 1 as one')
    expect(stmt.statement).not.toContain('`')
  })

  it('postgresql: keeps original identifiers/literals for a metadata-style query', () => {
    const sql = "select count(*) as c from information_schema.columns where table_name='x'"
    const stmt = classifySql(sql, 'postgresql').statements[0]!
    expect(stmt.statement).toBe(sql)
    expect(stmt.statement).not.toContain('`')
  })

  it('mysql: also executes the original text (uniform behaviour across dialects)', () => {
    const stmt = classifySql('select 1 as one', 'mysql').statements[0]!
    expect(stmt.statement).toBe('select 1 as one')
  })

  it('postgresql: keeps the original text on the regex fallback path (dialect-specific syntax)', () => {
    const sql = 'select count(*)::text as c from t where id = 1'
    const stmt = classifySql(sql, 'postgresql').statements[0]!
    expect(stmt.reliable).toBe(false)
    expect(stmt.statement).toBe(sql)
  })

  it('the regenerated text is exposed separately (cross-check input, never executed)', () => {
    const stmt = classifySql('select 1 as one', 'postgresql').statements[0]!
    // Regeneration may be dialect-lossy; the point is that it is NOT the
    // execution text, so a canonical form differing from the input is fine.
    if (stmt.normalized !== undefined) {
      expect(stmt.normalized).not.toBe(stmt.statement)
    }
  })

  it('multi-statement batches keep each original fragment, not the whole batch', () => {
    const result = classifySql('select 1 as a; select 2 as b', 'postgresql')
    expect(result.statements).toHaveLength(2)
    // The scanner keeps the trailing semicolon on all but the last fragment
    // (pre-existing behaviour); the point is per-statement original text.
    expect(result.statements[0]!.statement.replace(/;$/, '')).toBe('select 1 as a')
    expect(result.statements[1]!.statement).toBe('select 2 as b')
  })
})

describe('classifySql (AST layer)', () => {
  it('classifies SELECT as read with no limit detected', () => {
    const result = classifySql('SELECT * FROM users')
    expect(result.reliable).toBe(true)
    expect(result.statements).toHaveLength(1)
    const stmt = result.statements[0]!
    expect(stmt.kind).toBe('read')
    expect(stmt.dangerous).toBe(false)
    expect(stmt.limit).toBeNull()
    expect(isReadonlyBatch(result)).toBe(true)
  })

  it('detects an existing LIMIT', () => {
    const stmt = classifySql('SELECT * FROM users LIMIT 10').statements[0]!
    expect(typeof stmt.limit).toBe('number')
  })

  it('flags UPDATE without WHERE as dangerous', () => {
    const stmt = classifySql("UPDATE users SET name = 'x'").statements[0]!
    expect(stmt.kind).toBe('write')
    expect(stmt.dangerous).toBe(true)
    expect(stmt.reason).toContain('WHERE')
  })

  it('treats UPDATE with WHERE as normal write', () => {
    const stmt = classifySql("UPDATE users SET name = 'x' WHERE id = 1").statements[0]!
    expect(stmt.kind).toBe('write')
    expect(stmt.dangerous).toBe(false)
  })

  it('flags DROP as dangerous DDL', () => {
    const stmt = classifySql('DROP TABLE users').statements[0]!
    expect(stmt.kind).toBe('ddl')
    expect(stmt.dangerous).toBe(true)
  })

  it('refuses read channel statements mixed with writes (multi)', () => {
    const result = classifySql('SELECT 1; DELETE FROM logs')
    expect(result.statements.length).toBe(2)
    expect(isReadonlyBatch(result)).toBe(false)
    const del = result.statements.find((s) => s.kind === 'write')
    expect(del?.dangerous).toBe(true)
  })

  it('falls back to the rule layer on unparsable SQL and stays conservative', () => {
    const result = classifySql('FLUSH PRIVILEGES')
    expect(result.reliable).toBe(false)
    const stmt = result.statements[0]!
    expect(stmt.kind).toBe('unknown')
    expect(stmt.dangerous).toBe(true)
  })

  it('rule layer still recognizes plain SELECT after parse failure', () => {
    // Node-sql-parser usually parses this; force the fallback shape with a hint comment edge
    const result = classifySql('SELECT id FROM t /* trailing')
    if (!result.reliable) {
      const stmt = result.statements[0]!
      expect(stmt.kind).toBe('read')
      expect(stmt.dangerous).toBe(false)
    } else {
      expect(result.statements[0]!.kind).toBe('read')
    }
  })

  it('does not let string contents fake WHERE on write fallback', () => {
    const stmt = classifySql("UPDATE t SET a = 'WHERE fake'").statements[0]!
    if (stmt.reliable) {
      expect(stmt.dangerous).toBe(true)
    } else {
      expect(stmt.dangerous).toBe(true)
    }
  })
})

describe('hardened rules (audit round)', () => {
  it('blocks SELECT ... INTO on the read channel', () => {
    const result = classifySql("SELECT * FROM t INTO OUTFILE '/tmp/x'")
    const stmt = result.statements[0]!
    expect(stmt.blocked).toBe(true)
    expect(stmt.dangerous).toBe(true)
    expect(isReadonlyBatch(result)).toBe(false)
  })

  it('blocks USE statements (session-state pollution of pooled connections)', () => {
    const stmt = classifySql('USE mysql').statements[0]!
    expect(stmt.blocked).toBe(true)
    expect(stmt.dangerous).toBe(true)
  })

  it('blocks SET statements', () => {
    const stmt = classifySql('SET NAMES utf8mb4').statements[0]!
    expect(stmt.blocked).toBe(true)
    expect(stmt.dangerous).toBe(true)
  })

  it('wraps fallback statements when injecting LIMIT so trailing comments cannot swallow it', () => {
    const injected = injectReadLimit('SELECT id FROM t -- trailing comment', 50)
    expect(injected).toContain(') AS __dbm_l LIMIT 50')
    expect(injected.endsWith('LIMIT 50')).toBe(true)
    expect(injected.startsWith('SELECT * FROM (')).toBe(true)
  })
})

describe('EXPLAIN hardening (audit H1 fix)', () => {
  it('blocks EXPLAIN ANALYZE of a write — it actually executes the inner statement', () => {
    const result = classifySql('EXPLAIN ANALYZE DELETE FROM t')
    const stmt = result.statements[0]!
    expect(stmt.blocked).toBe(true)
    expect(stmt.dangerous).toBe(true)
    expect(isReadonlyBatch(result)).toBe(false)
  })

  it('refuses EXPLAIN of a write on the read channel (plan display is not a read)', () => {
    const result = classifySql('EXPLAIN DELETE FROM t')
    const stmt = result.statements[0]!
    expect(stmt.kind).toBe('unknown')
    expect(stmt.dangerous).toBe(true)
    expect(isReadonlyBatch(result)).toBe(false)
  })

  it('keeps allowing EXPLAIN of reads (plain, ANALYZE, FORMAT, FOR CONNECTION)', () => {
    for (const sql of ['EXPLAIN SELECT * FROM t', 'EXPLAIN ANALYZE SELECT * FROM t', 'EXPLAIN FORMAT=TREE SELECT * FROM t', 'EXPLAIN FOR CONNECTION 1']) {
      const stmt = classifySql(sql).statements[0]!
      expect(stmt.kind, sql).toBe('read')
      expect(stmt.dangerous, sql).toBe(false)
      expect(stmt.blocked, sql).toBeUndefined()
    }
  })

  it('neutralizes EXPLAIN wrapping a CTE-DELETE regardless of parse path', () => {
    const result = classifySql('EXPLAIN WITH cte AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM cte)')
    expect(result.statements[0]!.dangerous).toBe(true)
    expect(isReadonlyBatch(result)).toBe(false)
  })

  it('blocks EXPLAIN SELECT ... INTO OUTFILE', () => {
    const result = classifySql("EXPLAIN SELECT * FROM t INTO OUTFILE '/tmp/x'")
    const stmt = result.statements[0]!
    expect(stmt.blocked).toBe(true)
    expect(stmt.dangerous).toBe(true)
  })

  it('guards the AST explain wrapper against non-read inner nodes', () => {
    expect(explainInnerIsRead('select')).toBe(true)
    expect(explainInnerIsRead('SELECT')).toBe(true)
    expect(explainInnerIsRead('delete')).toBe(false)
    expect(explainInnerIsRead(undefined)).toBe(false)
    expect(explainInnerIsRead('')).toBe(false)
  })
})

describe('INSERT/REPLACE confirmation fix (audit M1)', () => {
  it('treats plain INSERT/REPLACE as normal writes (no confirmation loop)', () => {
    for (const sql of ['INSERT INTO t VALUES (1)', 'REPLACE INTO t VALUES (1)', 'INSERT INTO t (a) SELECT b FROM u WHERE x = 1']) {
      const stmt = classifySql(sql).statements[0]!
      expect(stmt.kind, sql).toBe('write')
      expect(stmt.dangerous, sql).toBe(false)
    }
  })

  it('still flags UPDATE/DELETE without WHERE as dangerous', () => {
    for (const sql of ['UPDATE t SET a = 1', 'DELETE FROM t']) {
      const stmt = classifySql(sql).statements[0]!
      expect(stmt.dangerous, sql).toBe(true)
      expect(stmt.reason, sql).toContain('WHERE')
    }
  })

  it('keeps the conservative verdict for parse-failed INSERT variants', () => {
    // Fallback layer: unknown-inner statements stay dangerous; a well-formed
    // INSERT that fails to parse still reads as write via the rule layer.
    const stmt = classifySql('INSERT INTO t VALUES (1) /* trailing').statements[0]!
    expect(['write', 'unknown']).toContain(stmt.kind)
    if (stmt.kind === 'write') expect(stmt.dangerous).toBe(false)
  })
})
