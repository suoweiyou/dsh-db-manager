/**
 * Runtime smoke test for lib/client.js — simulates the DSH browser
 * ModuleLoader environment in node:vm and asserts that loading the bundle
 * actually registers the plugin (the exact check DSH performs when it
 * reports "loaded without registering").
 *
 * Usage: node scripts/smoke-client.mjs
 * Exit 0 = bundle loads and registers; exit 1 = anything else.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bundlePath = path.join(root, 'lib', 'client.js')
const code = fs.readFileSync(bundlePath, 'utf8')

const registered = []
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(options) {
        const exports = options.factory((name) => {
          if (name === 'react') {
            // Minimal react stub: the bundle only needs createElement + hooks
            // identity at load time; apply() runs later in the real page.
            return {
              createElement: () => { throw new Error('createElement stub — not callable in smoke test') },
              useCallback: () => () => {},
              useEffect: () => {},
              useMemo: () => () => {},
              useState: () => [undefined, () => {}],
            }
          }
          if (name === 'react-dom') return {}
          throw new Error(`unexpected require in smoke test: ${name}`)
        })
        registered.push({ id: options.id, exports })
        return exports
      },
    },
  },
  fetch: () => { throw new Error('fetch stub — not callable in smoke test') },
  globalThis: {},
  console,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

try {
  vm.runInContext(code, sandbox, { filename: 'lib/client.js' })
} catch (error) {
  console.error('FAIL: bundle threw during evaluation:', error instanceof Error ? error.stack : error)
  process.exit(1)
}

if (registered.length !== 1) {
  console.error(`FAIL: expected exactly one __ModuleLoader__.load registration, got ${registered.length}`)
  process.exit(1)
}
const entry = registered[0]
if (entry.id !== 'dsh-db-manager') {
  console.error(`FAIL: registered id is "${entry.id}", expected "dsh-db-manager"`)
  process.exit(1)
}
// Plugin contract: `inject` is a string[] (service names), `apply` is the
// mount function. Check types accordingly.
const injectOk = Array.isArray(entry.exports?.inject) && entry.exports.inject.every((s) => typeof s === 'string')
const applyOk = typeof entry.exports?.apply === 'function'
if (!applyOk || !injectOk) {
  console.error(`FAIL: factory result shape wrong — apply=${typeof entry.exports?.apply}, inject=${JSON.stringify(entry.exports?.inject)}`)
  process.exit(1)
}
console.log(`SMOKE OK: bundle registered "${entry.id}" with exports [${Object.keys(entry.exports).join(', ')}], inject=${JSON.stringify(entry.exports.inject)}`)
