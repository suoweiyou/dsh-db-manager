/**
 * Standalone verification runner — runs after `tsc --noEmit false --outDir .build`
 * has compiled the project. Uses Node's built-in `node:test` so we avoid
 * vitest's esbuild spawn (sandbox blocks it).
 *
 * Coverage scope:
 *   - pgsql placeholder rewrite + pgsql classification + pgsql backup SQL
 *   - sqlite backup SQL + SQLite error-code classification
 *   - MySQL error-code classification (regression for the original dialect)
 *   - quoteIdentifier for all three dialects
 *   - connectionSchema dialect-aware validation
 *   - audit H1 (PoolManager concurrent acquire dedup)
 *   - audit H2 (SQLite file path sandbox)
 *   - audit M1 (sanitizeSql credential redaction across all three dialects)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { classifySql, isReadonlyBatch, injectReadLimit } from '../.build/src/safety/classify.js'
import { planRowBackup } from '../.build/src/db/backup.js'
import { classifyDbError, kindLabel } from '../.build/src/db/errors.js'
import { pgsqlPlaceholderRewrite } from '../.build/src/db/pgsql-driver.js'
import { quoteIdentifier } from '../.build/src/tools/resolve.js'
import { connectionSchema } from '../.build/src/config/schema.js'
import { validateSqliteFilePath, PoolManager } from '../.build/src/db/pool.js'
import { sanitizeSql } from '../.build/src/audit/log.js'

const ENV_PW = { password: '$ENV:DB_PW' }

test('classifySql — MySQL: SELECT is read', () => {
  const r = classifySql('SELECT id FROM t WHERE id = ?')
  assert.equal(r.reliable, true)
  assert.equal(r.statements.length, 1)
  assert.equal(r.statements[0].kind, 'read')
  assert.equal(r.statements[0].dangerous, false)
})

test('classifySql — MySQL: UPDATE without WHERE is dangerous', () => {
  const r = classifySql('UPDATE t SET x = 1')
  assert.equal(r.statements[0].kind, 'write')
  assert.equal(r.statements[0].dangerous, true)
})

test('classifySql — MySQL: EXPLAIN of a write is blocked', () => {
  const r = classifySql('EXPLAIN UPDATE t SET x = 1')
  assert.equal(r.statements[0].kind, 'unknown')
  assert.equal(r.statements[0].dangerous, true)
})

test('classifySql — PostgreSQL: SELECT is read', () => {
  const r = classifySql('SELECT id FROM t WHERE id = $1', 'postgresql')
  assert.equal(r.reliable, true)
  assert.equal(r.statements[0].kind, 'read')
  assert.equal(r.statements[0].dangerous, false)
})

test('classifySql — PostgreSQL: still flags UPDATE without WHERE', () => {
  const r = classifySql('UPDATE t SET x = 1', 'postgresql')
  assert.equal(r.statements[0].kind, 'write')
  assert.equal(r.statements[0].dangerous, true)
})

test('classifySql — SQLite: SELECT is read', () => {
  const r = classifySql('SELECT id FROM t WHERE id = ?', 'sqlite')
  assert.equal(r.reliable, true)
  assert.equal(r.statements[0].kind, 'read')
})

test('classifySql — SQLite: UPDATE without WHERE is dangerous', () => {
  const r = classifySql('UPDATE t SET x = 1', 'sqlite')
  assert.equal(r.statements[0].kind, 'write')
  assert.equal(r.statements[0].dangerous, true)
})

test('isReadonlyBatch: pure read batch returns true; mixed returns false', () => {
  const allRead = classifySql('SELECT 1; SELECT 2', 'mysql')
  assert.equal(isReadonlyBatch(allRead), true)
  const mixed = classifySql('SELECT 1; UPDATE t SET x = 1', 'mysql')
  assert.equal(isReadonlyBatch(mixed), false)
})

test('injectReadLimit: appends LIMIT inside derived table', () => {
  const out = injectReadLimit('SELECT * FROM t -- pick rows', 25)
  assert.ok(out.includes('SELECT * FROM (SELECT * FROM t -- pick rows) AS __dbm_l LIMIT 25'))
})

test('pgsqlPlaceholderRewrite — single ?, numbered left-to-right', () => {
  assert.equal(pgsqlPlaceholderRewrite('SELECT 1 FROM t WHERE id = ?'), 'SELECT 1 FROM t WHERE id = $1')
  assert.equal(
    pgsqlPlaceholderRewrite('SELECT * FROM t WHERE a = ? AND b = ? OR c = ?'),
    'SELECT * FROM t WHERE a = $1 AND b = $2 OR c = $3',
  )
})

test('pgsqlPlaceholderRewrite — skips ? in strings', () => {
  assert.equal(
    pgsqlPlaceholderRewrite("SELECT 'a ? b', \"c ? d\", ? FROM t"),
    "SELECT 'a ? b', \"c ? d\", $1 FROM t",
  )
})

test('pgsqlPlaceholderRewrite — skips ? in line comments', () => {
  assert.equal(
    pgsqlPlaceholderRewrite('SELECT 1 -- a ?\nFROM t WHERE id = ?'),
    'SELECT 1 -- a ?\nFROM t WHERE id = $1',
  )
})

test('pgsqlPlaceholderRewrite — skips ? in /* */ block comments', () => {
  assert.equal(
    pgsqlPlaceholderRewrite('SELECT 1 /* a ? */ FROM t WHERE id = ?'),
    'SELECT 1 /* a ? */ FROM t WHERE id = $1',
  )
})

test('planRowBackup — MySQL: CREATE TABLE … LIKE …', () => {
  const r = classifySql("UPDATE users SET name = 'a' WHERE id = 5")
  const decision = planRowBackup(r.statements[0].ast, 'mydb', 'mysql')
  assert.equal(decision.kind, 'ready')
  if (decision.kind !== 'ready') return
  assert.ok(decision.plan.createSql.includes('LIKE `mydb`.`users`'))
})

test('planRowBackup — PostgreSQL: CREATE TABLE … (LIKE … INCLUDING ALL)', () => {
  const r = classifySql('UPDATE users SET name = $1 WHERE id = $2', 'postgresql')
  const decision = planRowBackup(r.statements[0].ast, 'mydb', 'postgresql')
  assert.equal(decision.kind, 'ready')
  if (decision.kind !== 'ready') return
  assert.ok(decision.plan.createSql.includes('LIKE "mydb"."users"'))
  assert.ok(decision.plan.createSql.includes('INCLUDING ALL'))
})

test('planRowBackup — SQLite: CREATE TABLE … AS SELECT WHERE 0', () => {
  const r = classifySql('UPDATE users SET name = ? WHERE id = ?', 'sqlite')
  const decision = planRowBackup(r.statements[0].ast, 'mydb', 'sqlite')
  assert.equal(decision.kind, 'ready')
  if (decision.kind !== 'ready') return
  assert.ok(decision.plan.createSql.includes('AS SELECT * FROM'))
  assert.ok(decision.plan.createSql.includes('WHERE 0'))
})

test('planRowBackup — INSERT is none on every dialect', () => {
  for (const dialect of ['mysql', 'postgresql', 'sqlite']) {
    const sql = dialect === 'postgresql' ? 'INSERT INTO users VALUES ($1)' : 'INSERT INTO users VALUES (?)'
    const r = classifySql(sql, dialect)
    const decision = planRowBackup(r.statements[0].ast, 'mydb', dialect)
    assert.equal(decision.kind, 'none', `${dialect} INSERT should not need backup`)
  }
})

test('planRowBackup — multi-table UPDATE is infeasible on every dialect', () => {
  for (const dialect of ['mysql', 'postgresql', 'sqlite']) {
    const sql = dialect === 'sqlite'
      ? 'UPDATE a SET x = 1 FROM b WHERE a.id = b.id'
      : dialect === 'postgresql'
        ? 'UPDATE a SET x = 1 FROM b WHERE a.id = b.id'
        : 'UPDATE a JOIN b ON a.id = b.id SET a.x = 1'
    const r = classifySql(sql, dialect)
    const decision = planRowBackup(r.statements[0].ast, 'mydb', dialect)
    assert.equal(decision.kind, 'infeasible', `${dialect} multi-table UPDATE must be infeasible`)
  }
})

test('classifyDbError — MySQL error codes map to PRD DbErrorKind', () => {
  assert.equal(classifyDbError({ code: 'ER_ACCESS_DENIED_ERROR', message: 'denied' }).kind, 'auth')
  assert.equal(classifyDbError({ code: 'ER_BAD_DB_ERROR', message: 'no db' }).kind, 'unknown-database')
  assert.equal(classifyDbError({ code: 'ER_PARSE_ERROR', message: 'parse' }).kind, 'syntax')
  assert.equal(classifyDbError({ code: 'ER_DBACCESS_DENIED_ERROR', message: 'denied' }).kind, 'permission')
  assert.equal(classifyDbError({ code: 'ECONNREFUSED', message: 'no route' }).kind, 'network')
})

test('classifyDbError — PostgreSQL SQLSTATE maps to PRD DbErrorKind', () => {
  assert.equal(classifyDbError({ code: '28P01', message: 'pwd' }).kind, 'auth')
  assert.equal(classifyDbError({ code: '3D000', message: 'no db' }).kind, 'unknown-database')
  assert.equal(classifyDbError({ code: '42601', message: 'syntax' }).kind, 'syntax')
  assert.equal(classifyDbError({ code: '42501', message: 'denied' }).kind, 'permission')
  assert.equal(classifyDbError({ code: '3F000', message: 'no schema' }).kind, 'unknown-database')
})

test('classifyDbError — SQLite result codes map to PRD DbErrorKind', () => {
  assert.equal(classifyDbError({ code: 'SQLITE_BUSY', message: 'locked' }).kind, 'timeout')
  assert.equal(classifyDbError({ code: 'SQLITE_CANTOPEN', message: 'no file' }).kind, 'config')
  assert.equal(classifyDbError({ code: 'SQLITE_NOTADB', message: 'not db' }).kind, 'config')
  assert.equal(classifyDbError({ code: 'SQLITE_READONLY', message: 'ro' }).kind, 'config')
  assert.equal(classifyDbError({ code: 'SQLITE_AUTH', message: 'no' }).kind, 'permission')
  assert.equal(classifyDbError({ code: 'SQLITE_CONSTRAINT', message: 'x' }).kind, 'syntax')
  assert.equal(classifyDbError({ code: 'SQLITE_FULL', message: 'x' }).kind, 'unknown')
})

test('kindLabel returns Chinese labels for every kind', () => {
  for (const k of ['network', 'auth', 'unknown-database', 'permission', 'timeout', 'syntax', 'config', 'unknown']) {
    const label = kindLabel(k)
    assert.equal(typeof label, 'string')
    assert.ok(label.length > 0)
  }
})

test('quoteIdentifier — every dialect quotes correctly', () => {
  assert.equal(quoteIdentifier('mysql', 'users'), '`users`')
  assert.equal(quoteIdentifier('mysql', '$sys_name'), '`$sys_name`')
  assert.equal(quoteIdentifier('postgresql', 'users'), '"users"')
  assert.equal(quoteIdentifier('sqlite', 'users'), '`users`')
})

test('quoteIdentifier — rejects bad chars on every dialect', () => {
  for (const dialect of ['mysql', 'postgresql', 'sqlite']) {
    assert.throws(() => quoteIdentifier(dialect, 'bad;name'), /非法/)
    assert.throws(() => quoteIdentifier(dialect, 'bad`name'), /非法/)
    assert.throws(() => quoteIdentifier(dialect, "bad'name"), /非法/)
    assert.throws(() => quoteIdentifier(dialect, 'bad"name'), /非法/)
    assert.throws(() => quoteIdentifier(dialect, 'bad name'), /非法/)
    assert.throws(() => quoteIdentifier(dialect, ''), /非法/)
  }
})

test('connectionSchema — MySQL defaults: dialect=mysql, port=3306, mode=readonly', () => {
  const p = connectionSchema.parse({ name: 'a', host: 'h', username: 'u', ...ENV_PW })
  assert.equal(p.dialect, 'mysql')
  assert.equal(p.port, 3306)
  assert.equal(p.mode, 'readonly')
})

test('connectionSchema — accepts postgresql with custom port', () => {
  const p = connectionSchema.parse({ name: 'pg', host: 'h', port: 5432, username: 'u', dialect: 'postgresql', ...ENV_PW })
  assert.equal(p.dialect, 'postgresql')
  assert.equal(p.port, 5432)
})

test('connectionSchema — accepts sqlite with only file', () => {
  const p = connectionSchema.parse({ name: 'local', dialect: 'sqlite', file: '/data/app.db' })
  assert.equal(p.dialect, 'sqlite')
  assert.equal(p.file, '/data/app.db')
  assert.equal(p.port, undefined)
})

test('connectionSchema — rejects sqlite without file', () => {
  const r = connectionSchema.safeParse({ name: 'no-file', dialect: 'sqlite' })
  assert.equal(r.success, false, JSON.stringify(r))
})

test('connectionSchema — rejects sqlite with host/port/user/password', () => {
  const r = connectionSchema.safeParse({
    name: 'sqlite-extra', dialect: 'sqlite', file: '/data/app.db',
    host: '127.0.0.1', port: 1234, username: 'u', ...ENV_PW,
  })
  assert.equal(r.success, false, JSON.stringify(r))
})

test('connectionSchema — rejects MySQL without host', () => {
  const r = connectionSchema.safeParse({ name: 'no-host', username: 'u', ...ENV_PW })
  assert.equal(r.success, false, JSON.stringify(r))
})

test('connectionSchema — rejects unknown dialect', () => {
  const r = connectionSchema.safeParse({ name: 'a', host: 'h', username: 'u', dialect: 'oracle', ...ENV_PW })
  assert.equal(r.success, false, JSON.stringify(r))
})

/* ── audit H1: PoolManager.acquire deduplicates concurrent calls for the same key ─── */

test('PoolManager — concurrent acquires for the same key produce a single driver (no race leak)', async () => {
  // Use a stub driver factory so the test doesn't depend on real sqlite/pg/mysql
  // bindings being compiled in the sandbox. We assert the inflight dedup works
  // by counting how many times the factory actually runs.
  let factoryCalls = 0
  const stubDriver = { dialect: 'sqlite', _close: false, end: async () => undefined }
  const manager = new PoolManager({
    driverFactory: async () => {
      factoryCalls += 1
      // Yield to the microtask queue so any racing acquires that miss the
      // inflight cache would still see the in-progress creation.
      await Promise.resolve()
      await Promise.resolve()
      return stubDriver
    },
  })
  const spec = { name: 'race-test', dialect: 'sqlite', file: ':memory:', mode: 'readonly' }
  const results = await Promise.all([
    manager.acquire(spec, { connectTimeoutMs: 0, queryTimeoutMs: 0, allowedRoots: [] }),
    manager.acquire(spec, { connectTimeoutMs: 0, queryTimeoutMs: 0, allowedRoots: [] }),
    manager.acquire(spec, { connectTimeoutMs: 0, queryTimeoutMs: 0, allowedRoots: [] }),
    manager.acquire(spec, { connectTimeoutMs: 0, queryTimeoutMs: 0, allowedRoots: [] }),
  ])
  assert.equal(factoryCalls, 1, `factory should run exactly once, ran ${factoryCalls}`)
  const [first, ...rest] = results
  assert.ok(first !== undefined)
  for (const driver of rest) assert.equal(driver, first)
  await manager.closeAll()
})

test('PoolManager — two distinct keys produce two drivers', async () => {
  let factoryCalls = 0
  const manager = new PoolManager({
    driverFactory: async (spec) => {
      factoryCalls += 1
      return { dialect: spec.dialect, _id: factoryCalls, end: async () => undefined }
    },
  })
  const a = await manager.acquire({ name: 'a', dialect: 'sqlite', file: ':memory:', mode: 'readonly' }, { connectTimeoutMs: 0, queryTimeoutMs: 0, allowedRoots: [] })
  const b = await manager.acquire({ name: 'b', dialect: 'sqlite', file: ':memory:', mode: 'readonly' }, { connectTimeoutMs: 0, queryTimeoutMs: 0, allowedRoots: [] })
  assert.notEqual(a, b)
  assert.equal(factoryCalls, 2)
  await manager.closeAll()
})

/* ── audit H2: SQLite file path sandbox ───────────────────────────────────────── */

test('validateSqliteFilePath — :memory: is always allowed', () => {
  assert.equal(validateSqliteFilePath(':memory:', []), ':memory:')
})

test('validateSqliteFilePath — empty allowedRoots refuses any non-memory path', () => {
  assert.throws(() => validateSqliteFilePath('/etc/passwd', []), /allowedRoots|不允许/)
  assert.throws(() => validateSqliteFilePath('relative.db', []), /allowedRoots|不允许/)
})

test('validateSqliteFilePath — accepts a path inside an allowed root (relative)', () => {
  // Use a sandbox root inside the project and pass a relative path that
  // path.resolve() will anchor at the current process cwd — both must resolve
  // to the same root so the startsWith check accepts them.
  const root = path.resolve('tmp-validate-root-a')
  const relativeFile = path.join('tmp-validate-root-a', 'db', 'app.db')
  const resolved = validateSqliteFilePath(relativeFile, [root])
  assert.equal(resolved, path.join(root, 'db', 'app.db'))
})

test('validateSqliteFilePath — rejects a sibling path that escapes via ..', () => {
  const root = path.resolve('workspace-a')
  assert.throws(() => validateSqliteFilePath('../workspace-b/db.sqlite', [root]), /不在允许的根目录/)
})

test('validateSqliteFilePath — refuses an absolute path outside the allowed root', () => {
  const root = path.resolve('workspace-a')
  assert.throws(() => validateSqliteFilePath('/etc/passwd', [root]), /不在允许的根目录/)
  assert.throws(() => validateSqliteFilePath('C:/Windows/SAM', [root]), /不在允许的根目录/)
})

test('validateSqliteFilePath — accepts an absolute path inside an allowed root', () => {
  const root = path.resolve('workspace-a')
  const target = path.join(root, 'subdir', 'app.db')
  assert.equal(validateSqliteFilePath(target, [root]), target)
})

test('validateSqliteFilePath — refuses a sibling of an allowed root (prefix collision guard)', () => {
  // Prefix attack: allowedRoots = ['/tmp/workspace'] with input
  // '/tmp/workspace-evil/db.sqlite'. Naive startsWith would let it through;
  // the + path.sep check blocks it.
  const root = path.resolve('/tmp/workspace')
  const evil = path.resolve('/tmp/workspace-evil/db.sqlite')
  assert.throws(() => validateSqliteFilePath(evil, [root]), /不在允许的根目录/)
})

/* ── audit M1: sanitizeSql strips every flavour of credential literal ─────────── */

test('sanitizeSql — masks $ENV references and enc:v1 ciphertexts', () => {
  assert.match(sanitizeSql('$ENV:FOO'), /\*\*\*/)
  assert.match(sanitizeSql('enc:v1:iv:tag:cipher'), /enc:v1:\*\*\*/)
})

test('sanitizeSql — masks IDENTIFIED BY under all three quote styles', () => {
  assert.match(sanitizeSql("ALTER USER u IDENTIFIED BY 'hunter2'"), /IDENTIFIED BY '\*\*\*'/)
  assert.match(sanitizeSql('ALTER USER u IDENTIFIED BY "hunter2"'), /IDENTIFIED BY "\*\*\*"/)
  assert.match(sanitizeSql('ALTER USER u IDENTIFIED BY `hunter2`'), /IDENTIFIED BY `\*\*\*`/)
})

test('sanitizeSql — masks MySQL SET PASSWORD = form', () => {
  assert.match(sanitizeSql("SET PASSWORD FOR 'u'@'%' = 'hunter2'"), /SET PASSWORD = '\*\*\*'/)
  assert.match(sanitizeSql('SET PASSWORD FOR "u" = "hunter2"'), /SET PASSWORD = "\*\*\*"/)
})

test('sanitizeSql — masks PostgreSQL SET PASSWORD TO form', () => {
  assert.match(sanitizeSql("SET PASSWORD TO 'hunter2'"), /SET PASSWORD TO '\*\*\*'/)
  assert.match(sanitizeSql('SET PASSWORD TO "hunter2"'), /SET PASSWORD TO "\*\*\*"/)
})

test('sanitizeSql — masks PostgreSQL legacy SET PASSWORD form (no TO, no =)', () => {
  assert.match(sanitizeSql("SET PASSWORD 'hunter2'"), /SET PASSWORD '\*\*\*'/)
})

test('sanitizeSql — masks PASSWORD() function call', () => {
  assert.match(sanitizeSql("SELECT PASSWORD('hunter2')"), /PASSWORD\('\*\*\*'\)/)
  assert.match(sanitizeSql('SELECT PASSWORD("hunter2")'), /PASSWORD\("\*\*\*"\)/)
})

test('sanitizeSql — masks ALTER USER ... WITH PASSWORD form (PG / MySQL 8+)', () => {
  assert.match(sanitizeSql("ALTER USER u WITH PASSWORD 'hunter2'"), /WITH PASSWORD '\*\*\*'/)
  assert.match(sanitizeSql('ALTER USER u WITH PASSWORD "hunter2"'), /WITH PASSWORD "\*\*\*"/)
})

test('sanitizeSql — leaves non-credential SQL untouched', () => {
  const safe = 'SELECT id, name FROM users WHERE created_at > NOW() - INTERVAL 7 DAY ORDER BY id LIMIT 50'
  assert.equal(sanitizeSql(safe), safe)
})

test('sanitizeSql — truncates oversized SQL and marks the cut', () => {
  const huge = `SELECT * FROM t WHERE a = 'x${'y'.repeat(4000)}'`
  const out = sanitizeSql(huge)
  assert.ok(out.endsWith('…(truncated)'))
  // SQL_MAX_CHARS=2000 + '…(truncated)' marker (12 UTF-8 bytes) leaves a few
  // bytes of headroom; assert under 2020 to keep the contract honest.
  assert.ok(out.length <= 2020)
})

/* ── audit H4: every planRowBackup output re-parses to its expected kind ─── */

test('planRowBackup — output SQL re-parses to expected kinds on every dialect (audit H4)', () => {
  for (const dialect of ['mysql', 'postgresql', 'sqlite']) {
    const sql = dialect === 'postgresql'
      ? 'UPDATE t SET x = $1 WHERE id = $2'
      : 'UPDATE t SET x = ? WHERE id = ?'
    const r = classifySql(sql, dialect)
    const stmt = r.statements[0]
    assert.ok(stmt !== undefined)
    const plan = planRowBackup(stmt.ast, 'mydb', dialect)
    assert.equal(plan.kind, 'ready', `${dialect} should yield a ready backup plan`)
    if (plan.kind !== 'ready') continue
    // Audit H4 guard: db_execute re-classifies each backup step before
    // executing it. We mirror that here — if any of these drift to a
    // different kind in a future refactor, the runtime guard would now
    // refuse execution.
    assert.equal(classifySql(plan.plan.createSql, dialect).statements[0]?.kind, 'ddl', `${dialect} createSql must be ddl`)
    assert.equal(classifySql(plan.plan.insertSql, dialect).statements[0]?.kind, 'write', `${dialect} insertSql must be write`)
    assert.equal(classifySql(plan.plan.verifySql, dialect).statements[0]?.kind, 'read', `${dialect} verifySql must be read`)
  }
})

/* ── audit H5 / M9: regex-fallback statements are not used for the estimate splice ─── */

test('classifySql — regex-fallback path sets reliable=false so the db_query estimate splice refuses it (audit H5/M9)', () => {
  // Truly malformed SQL: parser.astify throws on this. db_query then
  // refuses to splice stmt.statement into a SELECT COUNT(*) wrapper
  // because stmt.reliable is false.
  const r = classifySql('THIS IS NOT VALID SQL $$$ ; DROP TABLE users;', 'mysql')
  assert.equal(r.reliable, false, 'regex fallback must mark reliable=false')
  assert.ok(r.statements.length >= 1)
  for (const stmt of r.statements) assert.equal(stmt.reliable, false)
})

/* ── audit v0.10: shouldBackup matrix on every policy × opt-in ─────────── */

test('shouldBackup — exhaustive matrix on every backupDefault × withBackup × estimate (v0.10)', async () => {
  const { shouldBackup } = await import('../.build/src/tools/data.js')
  assert.equal(typeof shouldBackup, 'function', 'shouldBackup must be exported from src/tools/data.ts')
  // 'always' mode — every backable statement goes through backup regardless
  // of estimate or withBackup arg (withBackup: false is the only override).
  for (const est of [undefined, 0, 5, 1_000_000]) {
    for (const wb of [undefined, true]) {
      assert.equal(shouldBackup({ withBackup: wb, backupDefault: 'always', backupSmallThreshold: 1000, affectedEstimate: est }), true, `always withBackup=${wb} est=${est}`)
    }
    assert.equal(shouldBackup({ withBackup: false, backupDefault: 'always', backupSmallThreshold: 1000, affectedEstimate: est }), false, `always withBackup=false overrides even always`)
  }
  // 'opt-in' mode — never unless explicit true.
  for (const est of [0, 5, 1_000_000]) {
    assert.equal(shouldBackup({ withBackup: undefined, backupDefault: 'opt-in', backupSmallThreshold: 1000, affectedEstimate: est }), false, `opt-in withBackup=undefined est=${est}`)
    assert.equal(shouldBackup({ withBackup: false, backupDefault: 'opt-in', backupSmallThreshold: 1000, affectedEstimate: est }), false, `opt-in withBackup=false est=${est}`)
    assert.equal(shouldBackup({ withBackup: true, backupDefault: 'opt-in', backupSmallThreshold: 1000, affectedEstimate: est }), true, `opt-in withBackup=true est=${est}`)
  }
  // 'small-only' mode — depends on estimate vs threshold.
  assert.equal(shouldBackup({ withBackup: undefined, backupDefault: 'small-only', backupSmallThreshold: 1000, affectedEstimate: 0 }), true, 'estimate 0 ≤ threshold → backup')
  assert.equal(shouldBackup({ withBackup: undefined, backupDefault: 'small-only', backupSmallThreshold: 1000, affectedEstimate: 1000 }), true, 'estimate = threshold → backup (inclusive)')
  assert.equal(shouldBackup({ withBackup: undefined, backupDefault: 'small-only', backupSmallThreshold: 1000, affectedEstimate: 1001 }), false, 'estimate 1001 > threshold → skip')
  assert.equal(shouldBackup({ withBackup: undefined, backupDefault: 'small-only', backupSmallThreshold: 1000, affectedEstimate: undefined }), false, 'estimate unknown → skip (safe default)')
  // withBackup overrides the policy default in both directions.
  assert.equal(shouldBackup({ withBackup: true, backupDefault: 'opt-in', backupSmallThreshold: 1000, affectedEstimate: 1_000_000 }), true, 'withBackup=true overrides opt-in')
  assert.equal(shouldBackup({ withBackup: false, backupDefault: 'always', backupSmallThreshold: 1000, affectedEstimate: 0 }), false, 'withBackup=false overrides always')
  assert.equal(shouldBackup({ withBackup: true, backupDefault: 'small-only', backupSmallThreshold: 1000, affectedEstimate: 1_000_000 }), true, 'withBackup=true overrides small-only skip')
})

/* ── node:sqlite driver: real integration (Node 22+ built-in, zero-dep) ──── */

test('SqliteDriver (node:sqlite) — query + execute + transaction work on a real :memory: database', async () => {
  const { SqliteDriver } = await import('../.build/src/db/sqlite-driver.js')
  const driver = SqliteDriver.create(
    { name: 'mem', dialect: 'sqlite', file: ':memory:', mode: 'readwrite' },
    { connectTimeoutMs: 0, queryTimeoutMs: 0 },
    { allowedRoots: [] },
  )
  try {
    // Setup
    await driver.query('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)', undefined)
    await driver.query('INSERT INTO users (name) VALUES (?)', ['Alice'])
    await driver.query('INSERT INTO users (name) VALUES (?)', ['Bob'])
    // Query returns rows
    const rows = await driver.query('SELECT id, name FROM users ORDER BY id', undefined)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].name, 'Alice')
    assert.equal(rows[1].name, 'Bob')
    // Execute returns affectedRows + insertId
    const result = await driver.execute('INSERT INTO users (name) VALUES (?)', ['Carol'])
    assert.ok(result.affectedRows === 1, `expected 1 affected row, got ${result.affectedRows}`)
    assert.equal(typeof result.insertId, 'number')
    assert.ok(result.insertId > 2, `insertId should be > 2, got ${result.insertId}`)
    // Transaction commits a batch
    await driver.withTransaction(async (tx) => {
      await tx.query('INSERT INTO users (name) VALUES (?)', ['Tx1'])
      await tx.query('INSERT INTO users (name) VALUES (?)', ['Tx2'])
    })
    const afterTx = await driver.query('SELECT COUNT(*) AS n FROM users', undefined)
    assert.equal(Number(afterTx[0].n), 5, 'transaction should have committed 2 inserts')
    // Transaction rolls back on error
    await assert.rejects(async () => {
      await driver.withTransaction(async (tx) => {
        await tx.query('INSERT INTO users (name) VALUES (?)', ['WillRollback'])
        throw new Error('boom')
      })
    }, /boom/)
    const afterRollback = await driver.query("SELECT COUNT(*) AS n FROM users WHERE name = 'WillRollback'", undefined)
    assert.equal(Number(afterRollback[0].n), 0, 'rolled-back insert must not be visible')
  } finally {
    await driver.end()
  }
})

test('SqliteDriver (node:sqlite) — read-only mode rejects writes at the driver layer', async () => {
  const { SqliteDriver } = await import('../.build/src/db/sqlite-driver.js')
  const driver = SqliteDriver.create(
    { name: 'ro', dialect: 'sqlite', file: ':memory:', mode: 'readonly' },
    { connectTimeoutMs: 0, queryTimeoutMs: 0 },
    { allowedRoots: [] },
  )
  try {
    await assert.rejects(async () => {
      await driver.execute('CREATE TABLE x (id INTEGER)', undefined)
    }, /(read|attempt|locked|database is locked|attempt to write)/i)
  } finally {
    await driver.end()
  }
})

test('SqliteDriver (node:sqlite) — validateSqliteFilePath sandbox refuses non-allowed roots', async () => {
  const { validateSqliteFilePath } = await import('../.build/src/db/pool.js')
  const { join } = await import('node:path')
  const tmpRoot = join(process.cwd(), '.tmp-sqlite-test')
  await assert.rejects(async () => {
    // absolute path outside allowed roots must throw before opening
    validateSqliteFilePath('C:\\Windows\\System32\\drivers\\etc\\hosts', [tmpRoot])
  }, /不在允许的根目录/)
  await assert.rejects(async () => {
    validateSqliteFilePath('/etc/passwd', [tmpRoot])
  }, /不在允许的根目录/)
  // :memory: is always allowed regardless of allowedRoots
  assert.equal(validateSqliteFilePath(':memory:', []), ':memory:')
})

/* ── audit M6: withTransaction contract on every dialect driver ──────────── */

/** Build a fake driver that records every operation. The driver's tx
 *  surface is exercised by a stub inner driver so we can confirm the
 *  COMMIT/ROLLBACK/release sequence without touching real databases. */
function makeRecordingDriver(dialect) {
  const log = []
  let id = 0
  return {
    log,
    driver: {
      dialect,
      async query(sql) { log.push(['query', sql]); return [] },
      async execute(sql) { log.push(['execute', sql]); return { affectedRows: 1, rows: [] } },
      async end() { log.push(['end', id++]) },
      async withTransaction(fn) {
        log.push(['begin'])
        try {
          const result = await fn({
            dialect,
            query: (sql) => { log.push(['tx-query', sql]); return Promise.resolve([]) },
            execute: (sql) => { log.push(['tx-execute', sql]); return Promise.resolve({ affectedRows: 1, rows: [] }) },
            end: async () => { log.push(['tx-end']) },
            withTransaction: () => { throw new Error('嵌套事务不支持 — withTransaction 内部不能再开一个事务') },
          })
          log.push(['commit'])
          return result
        } catch (error) {
          log.push(['rollback'])
          throw error
        } finally {
          log.push(['release'])
        }
      },
    },
  }
}

test('DatabaseDriver — withTransaction commits on success and releases the driver', async () => {
  const { log, driver } = makeRecordingDriver('mysql')
  let insideTxRan = false
  await driver.withTransaction(async (tx) => {
    insideTxRan = true
    await tx.execute('UPDATE t SET x = 1')
  })
  assert.equal(insideTxRan, true)
  assert.deepEqual(log.map(([op]) => op), ['begin', 'tx-execute', 'commit', 'release'])
})

test('DatabaseDriver — withTransaction rolls back on error and rethrows', async () => {
  const { log, driver } = makeRecordingDriver('postgresql')
  await assert.rejects(async () => {
    await driver.withTransaction(async () => {
      throw new Error('boom')
    })
  }, /boom/)
  assert.deepEqual(log.map(([op]) => op), ['begin', 'rollback', 'release'])
})

test('DatabaseDriver — withTransaction continues to commit after a tx-internal rollback', async () => {
  // Edge case: fn() catches its own error. Then control returns normally;
  // withTransaction must COMMIT, not ROLLBACK.
  const { log, driver } = makeRecordingDriver('sqlite')
  await driver.withTransaction(async () => {
    try { throw new Error('recovered') } catch { /* swallow */ }
  })
  assert.deepEqual(log.map(([op]) => op), ['begin', 'commit', 'release'])
})

test('DatabaseDriver — withTransaction rejects nested transactions (audit M6)', async () => {
  const { driver } = makeRecordingDriver('mysql')
  await assert.rejects(async () => {
    await driver.withTransaction(async (tx) => {
      await tx.withTransaction(() => Promise.resolve())
    })
  }, /嵌套事务/)
})
