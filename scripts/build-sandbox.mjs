/**
 * Sandbox-friendly build for dsh-db-manager.
 *
 * Why this file exists: the DSH agent sandbox denies `spawn` (esbuild's
 * service process), so `tsup` / `npm run build` cannot run inside the DSH
 * session — every attempt fails with `spawn EPERM` (开发规范 §5.2 documents
 * the same limitation for vitest, worked around by scripts/run-vitest.mjs).
 * This script produces the deployable `lib/` without spawning esbuild:
 *
 *   1. Host half — `tsc` (pure in-process compile) emits the whole `src/`
 *      tree to `lib/` as multi-file ESM. Node resolves relative imports at
 *      runtime, externals (mysql2 / zod / @deepseek-ai/*) stay as `import`
 *      statements. Behavior-equivalent to tsup's host bundle; the only
 *      visible difference is more files under lib/ (package.json `files`
 *      already includes the whole `lib` directory, so publishing is fine).
 *
 *      ⚠ node:sqlite rewrite: tsup's node-protocol plugin would rewrite a
 *      static `import … from 'node:sqlite'` into the (nonexistent) bare
 *      name `sqlite` — that is why src/db/sqlite-driver.ts uses
 *      `process.getBuiltinModule('node:sqlite')`. This script passes the
 *      source through unmodified, so the runtime call survives.
 *
 *   2. Client half — TypeScript's transpileModule API compiles the three
 *      client files in-process, then merges them into ONE CommonJS bundle
 *      wrapped with the ModuleLoader banner/footer from tsup.config.ts
 *      (react/react-dom stay external → require()).
 *
 * Usage:   node scripts/build-sandbox.mjs
 * Output:  lib/index.js + supporting ESM files, lib/index.d.ts, lib/client.js
 *
 * On the DSH host (outside the sandbox) the canonical build remains
 * `npm run build` (tsup single-file bundles). This script is for agents
 * working inside a DSH session that needs to deploy their own changes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ts = require(path.join(root, 'node_modules', 'typescript', 'lib', 'typescript.js'))

// ── Shared tsconfig base (read from disk so CLI tsc and this stay in sync) ─
const tsconfigRaw = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
if (tsconfigRaw.error !== undefined) {
  throw new Error(`tsconfig.json parse failed: ${ts.flattenDiagnosticMessageText(tsconfigRaw.error.messageText, '\n')}`)
}

// ── Step 1: host half — full emit via the TS API (multi-file ESM) ─────────
{
  const hostOutDir = path.join(root, 'lib')
  const hostConfig = ts.parseJsonConfigFileContent(
    {
      compilerOptions: {
        ...tsconfigRaw.config.compilerOptions,
        noEmit: false,
        declaration: true,
        outDir: hostOutDir,
        rootDir: path.join(root, 'src'),
      },
      // Only src/** (tests stay out of the deployable bundle).
      include: [path.join(root, 'src', '**', '*')],
    },
    ts.sys,
    root,
  )
  const program = ts.createProgram(hostConfig.fileNames, hostConfig.options)
  const emit = program.emit()
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emit.diagnostics)
  if (diagnostics.length > 0) {
    for (const d of diagnostics.slice(0, 10)) {
      const file = d.file?.fileName ?? '?'
      const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
      console.error(`TS${d.code}: ${file}: ${msg}`)
    }
    throw new Error(`host compile failed (${diagnostics.length} diagnostics)`)
  }
  const files = fs.readdirSync(hostOutDir, { recursive: true }).filter((f) => /\.(js|d\.ts)$/.test(String(f)))
  console.log(`host OK → lib/ (${files.length} files)`)
}

// ── Step 2: client half — transpileModule + merge into one CJS bundle ─────
const clientDir = path.join(root, 'src', 'client')
const clientFiles = ['api.ts', 'Section.ts', 'main.ts']

const clientOutputs = new Map()
for (const name of clientFiles) {
  const source = fs.readFileSync(path.join(clientDir, name), 'utf8')
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      // ESM so imports/exports are uniform for the merge pass below.
      ...tsconfigRaw.config.compilerOptions,
      module: 'ESNext',
      noEmit: undefined,
    },
    fileName: name,
  })
  clientOutputs.set(name.replace(/\.ts$/, '.js'), transpiled.outputText)
}

const apiJs = clientOutputs.get('api.js')
const sectionJs = clientOutputs.get('Section.js')
const mainJs = clientOutputs.get('main.js')
if (apiJs === undefined || sectionJs === undefined || mainJs === undefined) {
  throw new Error(`expected api.js / Section.js / main.js in transpile output, got: ${[...clientOutputs.keys()].join(', ')}`)
}

/**
 * Convert one compiled ESM file into a CJS module factory body:
 *   - `import { A, B as C } from 'external'` → `const { A, B: C } = require('external')`
 *   - `import { A, B } from './relative.js'` → `const { A, B } = __dbm_modules['<resolved>']`
 *   - `export { A, B as C };` → `exports['A'] = A; exports['C'] = B;`
 *   - `export class X` / `export function f` / `export async function f` → declare + re-export
 * Only the shapes above appear in src/client — anything else fails loudly
 * so we never ship a silently-wrong bundle.
 */
function toCjsBody(source) {
  const exportNames = []
  let body = source

  // 1) single-line named imports. Keep the `imported: local` mapping —
  // dropping the imported name silently breaks aliased imports:
  // `import { createElement as h } from 'react'` must become
  // `const { createElement: h } = require("react")`, NOT `const { h } = …`
  // (which yields undefined at render time — the blank-pane bug).
  const importPattern = /^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?\s*$/gm
  body = body.replace(importPattern, (_match, names, from) => {
    const mapped = names.split(',').map((entry) => {
      const parts = entry.trim().split(/\s+as\s+/)
      const imported = parts[0].trim()
      const local = (parts[1] ?? parts[0]).trim()
      return imported === local ? local : `${imported}: ${local}`
    }).join(', ')
    if (from.startsWith('.')) {
      const resolved = from.replace(/^\.\//, '').replace(/\.js$/, '')
      return `const { ${mapped} } = __dbm_modules[${JSON.stringify(resolved)}];`
    }
    return `const { ${mapped} } = require(${JSON.stringify(from)});`
  })

  // 2) trailing `export { ... };` lists.
  const exportListPattern = /^export\s+\{([^}]+)\};?\s*$/gm
  body = body.replace(exportListPattern, (_match, names) => {
    for (const entry of names.split(',')) {
      const parts = entry.split(/\s+as\s+/).map((s) => s.trim())
      const local = parts[0]
      const exported = parts[1] ?? parts[0]
      exportNames.push({ local, exported })
    }
    return ''
  })

  // 3) inline `export class X` / `export function f` / `export const c`.
  const inlinePattern = /^export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm
  // A multi-declarator statement (`export const a = 1, b = 2`) would export only
  // the first name — refuse loudly instead of shipping a half-exported module.
  if (/^export\s+(?:const|let|var)\s+[^=\n]*,[^=\n]*=/m.test(body)) {
    throw new Error('unhandled multi-declarator export in client file')
  }
  body = body.replace(inlinePattern, (_match, kind, name) => {
    exportNames.push({ local: name, exported: name })
    return `${kind} ${name}`
  })

  if (/^export\s+(?!class\b|function\b|async\b|const\b|let\b|var\b|\{)/m.test(body)) {
    throw new Error(`unhandled export shape in client file: ${body.match(/^export\s+\S+/m)?.[0]?.slice(0, 80)}`)
  }

  const exportLines = exportNames
    .map(({ local, exported }) => `exports[${JSON.stringify(exported)}] = ${local};`)
    .join('\n')

  return `${body}\n${exportLines}\n`
}

const banner = 'window.__ModuleLoader__.load({ id: "dsh-db-manager", factory: (require) => { var module = { exports: {} }; var exports = module.exports;'
const footer = 'return module.exports; } });'

// Sequential assignment statements, NOT an object literal: each module IIFE
// runs while it executes its imports (`__dbm_modules['api']`), so the
// registry object must already exist AND earlier entries must already be
// assigned. An object literal would evaluate every IIFE *before* the
// assignment to __dbm_modules happens (the exact bug the smoke test caught).
// Order matters: api → Section → main matches the import direction.
const registry = [
  ['api', toCjsBody(apiJs)],
  ['Section', toCjsBody(sectionJs)],
  ['main', toCjsBody(mainJs)],
].map(([id, body]) => `__dbm_modules[${JSON.stringify(id)}] = ((exports) => {\n${body}\nreturn exports;})({});`)
  .join('\n')

const client = `${banner}
var __dbm_modules = {};
${registry}
// Re-export the entry module's apply/inject as the bundle's module.exports.
for (var __k in __dbm_modules['main']) { module.exports[__k] = __dbm_modules['main'][__k]; }
${footer}
`

// ── Syntax gate: parse the assembled bundle before writing it. A syntax
// error here would ship a client.js whose whole script fails to parse, so
// __ModuleLoader__.load never runs and DSH reports "loaded without
// registering" (the exact failure mode of the first broken build).
{
  const { Script } = await import('node:vm')
  try {
    new Script(client, { filename: 'lib/client.js' })
  } catch (error) {
    console.error('assembled client bundle has a syntax error — refusing to write it:')
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

// ── Runtime gate: execute the bundle in a sandboxed vm with a stub
// ModuleLoader, assert the registration contract (id + apply/inject exports),
// AND invoke the registered settings component through a mini hooks runtime.
// The render check catches load-time-invisible bugs that only explode when
// React calls the component — e.g. the aliased-import bug that shipped
// `const { h } = require("react")` (undefined) and produced a blank settings
// pane in the real shell while every registration-level check passed.
{
  const vm = await import('node:vm')
  const createElementCalls = { count: 0 }
  const reactStub = {
    createElement: (...args) => {
      createElementCalls.count += 1
      return { $$typeof: Symbol.for('react.element'), type: args[0], props: { children: args[2] } }
    },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useCallback: (fn) => fn,
    useMemo: (factory) => factory(),
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
  }
  const registered = []
  let registeredSlot = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(options) {
          const exports = options.factory((name) => {
            if (name === 'react') return reactStub
            if (name === 'react-dom') return {}
            throw new Error(`unexpected require during build gate: ${name}`)
          })
          registered.push({ id: options.id, exports })
          return exports
        },
      },
    },
    fetch: () => { throw new Error('fetch stub — not callable during build gate') },
    console: { log: () => {}, error: () => {}, warn: () => {} },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  try {
    vm.runInContext(client, sandbox, { filename: 'lib/client.js' })
  } catch (error) {
    console.error('client bundle threw during evaluation — refusing to write it:')
    console.error(error instanceof Error ? error.stack : error)
    process.exit(1)
  }
  const entry = registered[0]
  const applyOk = entry !== undefined && typeof entry.exports?.apply === 'function'
  const injectOk = entry !== undefined && Array.isArray(entry.exports?.inject) && entry.exports.inject.every((s) => typeof s === 'string')
  if (entry === undefined || entry.id !== 'dsh-db-manager' || !applyOk || !injectOk) {
    console.error(`client bundle failed the registration contract — refusing to write it (id=${entry?.id}, apply=${entry?.exports?.apply === undefined ? 'missing' : typeof entry.exports.apply}, inject=${JSON.stringify(entry?.exports?.inject)})`)
    process.exit(1)
  }
  // Render gate: run apply → slots.inject callback → slots.register, then call
  // the captured component. createElement must be invoked (the page renders
  // unconditionally) and the component must not throw.
  entry.exports.apply({
    slots: {
      inject(slot, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        registeredSlot = { options, component }
        return () => {}
      },
    },
  })
  const component = registeredSlot?.component
  if (typeof component !== 'function') {
    console.error('client bundle registered no settings component — refusing to write it')
    process.exit(1)
  }
  try {
    const element = component({ close: () => {} })
    if (createElementCalls.count === 0) {
      console.error('render gate failed: component never called createElement — refusing to write it')
      process.exit(1)
    }
    if (element === null || element === undefined || typeof element !== 'object') {
      console.error(`render gate failed: component returned ${String(element)} — refusing to write it`)
      process.exit(1)
    }
  } catch (error) {
    console.error('render gate failed: component threw during a synchronous render pass — refusing to write it:')
    console.error(error instanceof Error ? error.stack : error)
    process.exit(1)
  }
  console.log(`client gate OK: registered "${entry.id}" exports=[${Object.keys(entry.exports).join(', ')}] inject=${JSON.stringify(entry.exports.inject)} render=(${createElementCalls.count} createElement calls)`)
}

fs.writeFileSync(path.join(root, 'lib', 'client.js'), client, 'utf8')
console.log(`client OK → lib/client.js (${client.length} bytes)`)
console.log('build-sandbox complete')
