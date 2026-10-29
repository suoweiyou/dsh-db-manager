/**
 * Drop-in shim for the `vitest` module API used by this project's specs.
 *
 * Why: DSH sandbox blocks the esbuild subprocess that vitest spawns to
 * bundle its config file. Importing vitest directly also fails because
 * vitest refuses to be imported outside its own runtime context. This shim
 * lets us run the compiled spec files with plain `node` by intercepting
 * the `vitest` import specifier (see `vitest-loader.mjs`) and providing the
 * subset of the vitest API our specs use:
 *
 *   describe(name, fn)
 *   it(name, fn)
 *   beforeEach(fn) / afterEach(fn)
 *   beforeAll(fn) / afterAll(fn)
 *   expect(value)
 *     .toBe / .toEqual / .toContain / .toMatch / .toBeTruthy / .toBeUndefined
 *     .toHaveLength / .toMatchObject / .toBeLessThan / .toBeLessThanOrEqual
 *     .not.* (negation chain)
 *
 * No test filtering, no parallelism, no watch mode — just enough to run
 * every spec file we ship on `node`-equivalent semantics.
 */
import { strict as assert } from 'node:assert'

/** A flat list of suites in registration order. We track them as a
 *  linear list rather than a tree because we capture hooks + tests into
 *  each suite at the moment the describe() callback finishes. The parent
 *  pointer is only used to walk ancestors for hook inheritance.
 *
 * Hooks declared OUTSIDE any describe (at module top level) live on
 * `globalSuite` and are inherited by every test across all suites. */
const suites = []
const stack = []        // current describe() frames (innermost last)
const globalSuite = { name: '(global)', parent: null, tests: [], beforeEach: [], afterEach: [], beforeAll: [], afterAll: [] }

export function describe(name, fn) {
  const suite = {
    name,
    parent: stack[stack.length - 1] ?? null,
    tests: [],
    beforeEach: [],
    afterEach: [],
    beforeAll: [],
    afterAll: [],
  }
  suites.push(suite)
  stack.push(suite)
  try {
    fn()
  } finally {
    stack.pop()
  }
}

export function it(name, fn) {
  const suite = stack[stack.length - 1] ?? globalSuite
  suite.tests.push({ name, fn })
}

export function beforeEach(fn) {
  const suite = stack[stack.length - 1] ?? globalSuite
  suite.beforeEach.push(fn)
}
export function afterEach(fn) {
  const suite = stack[stack.length - 1] ?? globalSuite
  suite.afterEach.push(fn)
}
export function beforeAll(fn) {
  const suite = stack[stack.length - 1] ?? globalSuite
  suite.beforeAll.push(fn)
}
export function afterAll(fn) {
  const suite = stack[stack.length - 1] ?? globalSuite
  suite.afterAll.push(fn)
}

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false
  return true
}

function stringify(v) {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try { return JSON.stringify(v) } catch { return String(v) }
}

function makeMatchers(value, negated) {
  function fail(msg) { throw new assert.AssertionError({ message: msg, actual: value }) }
  function ok(cond, msg) { if (!cond) fail(msg) }
  const m = {
    toBe(expected) { ok(Object.is(value, expected), `expected ${stringify(expected)}, got ${stringify(value)}`) },
    toEqual(expected) { ok(deepEqual(value, expected), `expected deep equal ${stringify(expected)}, got ${stringify(value)}`) },
    toContain(expected) {
      ok(typeof value === 'string' || Array.isArray(value), '.toContain requires string or array')
      ok(value !== null && value !== undefined && typeof value.includes === 'function' && value.includes(expected), `${stringify(value)} does not contain ${stringify(expected)}`)
    },
    toMatch(re) {
      ok(typeof value === 'string', '.toMatch requires string')
      ok(re instanceof RegExp ? re.test(value) : value.includes(re), `value does not match`)
    },
    toBeTruthy() { ok(Boolean(value), 'expected truthy') },
    toBeUndefined() { ok(value === undefined, 'expected undefined') },
    toBeDefined() { ok(value !== undefined, 'expected defined') },
    toBeNull() { ok(value === null, 'expected null') },
    toBeGreaterThan(expected) { ok(typeof value === 'number' && value > expected, 'expected >') },
    toBeLessThan(expected) { ok(typeof value === 'number' && value < expected, 'expected <') },
    toBeLessThanOrEqual(expected) { ok(typeof value === 'number' && value <= expected, 'expected <=') },
    toHaveLength(expected) { ok((typeof value === 'string' || Array.isArray(value)) && value.length === expected, `expected length ${expected}, got ${value?.length}`) },
    toMatchObject(expected) {
      ok(typeof value === 'object' && value !== null, '.toMatchObject requires object')
      for (const k of Object.keys(expected)) if (!deepEqual(value[k], expected[k])) fail(`property ${k} mismatch`)
    },
    toThrow(matcher) {
      ok(typeof value === 'function', '.toThrow requires function')
      let thrown = null
      try { value() } catch (e) { thrown = e }
      if (matcher === undefined) ok(thrown !== null, 'expected to throw')
      else if (thrown === null) fail('expected to throw')
      else if (matcher instanceof RegExp) ok(matcher.test(thrown.message), `thrown ${thrown.message}`)
      else if (typeof matcher === 'string') ok(thrown.message.includes(matcher), `thrown ${thrown.message}`)
      else if (typeof matcher === 'function') ok(thrown instanceof matcher, `thrown ${thrown.message} is not instance of matcher`)
      else fail('.toThrow matcher must be RegExp or string or Error class')
    },
    toBeInstanceOf(cls) {
      ok(value instanceof cls, `expected instance of ${cls?.name ?? '?'}`)
    },
  }
  if (negated) {
    const wrapped = {}
    for (const k of Object.keys(m)) {
      wrapped[k] = (...args) => {
        try { m[k](...args); fail(`expected not.${k}`) }
        catch (e) { if (!(e instanceof assert.AssertionError)) throw e }
      }
    }
    return wrapped
  }
  return addNot(m, value)
}

export function expect(value) { return makeMatchers(value, false) }

/** Extend makeMatchers to support `.not.*` chains via a `not` accessor. */
function addNot(m, value) {
  Object.defineProperty(m, 'not', {
    get: () => makeMatchers(value, true),
    enumerable: true,
    configurable: true,
  })
  return m
}

/** Walk every suite (DFS via parent chain) and collect a flat test list
 *  with its inherited beforeEach / afterEach chains. The test name is
 *  "<outer> > <inner> > <test>". */
function ancestors(suite) {
  const chain = []
  let cur = suite
  while (cur !== null) {
    chain.unshift(cur)
    cur = cur.parent
  }
  return chain
}

export async function runAll() {
  let pass = 0, fail = 0
  const failures = []
  for (const suite of [...suites]) {
    const chain = [globalSuite, ...ancestors(suite)]
    const befores = chain.flatMap((s) => s.beforeEach)
    const afters = chain.flatMap((s) => s.afterEach).reverse()
    const beforesAll = chain.flatMap((s) => s.beforeAll)
    const aftersAll = chain.flatMap((s) => s.afterAll).reverse()
    for (const h of beforesAll) await h()
    for (const test of suite.tests) {
      const name = chain.map((s) => s.name).filter((n) => n !== '(global)').join(' > ') + ' > ' + test.name
      try {
        for (const h of befores) await h()
        await test.fn()
        pass += 1
      } catch (e) {
        fail += 1
        failures.push({ name, err: e })
      } finally {
        for (const h of afters) { try { await h() } catch (e) { /* swallow */ } }
      }
    }
    for (const h of aftersAll) await h()
  }
  return { pass, fail, failures }
}

/** Clear all registered suites + global hooks (between spec files). */
export function reset() {
  suites.length = 0
  globalSuite.tests.length = 0
  globalSuite.beforeEach.length = 0
  globalSuite.afterEach.length = 0
  globalSuite.beforeAll.length = 0
  globalSuite.afterAll.length = 0
}
