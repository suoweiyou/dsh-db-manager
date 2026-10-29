/**
 * Full-fidelity render test for lib/client.js against the real React 18:
 * load bundle in vm (seed-shaped react stub) → apply(ctx) → capture the
 * settings.section component → invoke it with a mini hooks runtime. Any
 * exception here is exactly what the DSH shell turns into a blank pane.
 *
 * Usage: node scripts/render-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const React = require('react')

// Mini hooks runtime — enough for one synchronous render pass (the shape a
// component must survive without throwing).
const hooks = {
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useCallback: (fn) => fn,
  useMemo: (factory) => factory(),
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
}
const reactStub = { ...hooks, createElement: React.createElement }

// Reproduce the DSH seed shape for react exactly: a frozen, null-proto
// namespace carrying `default` plus getter-mapped named exports
// (see dsh-web-frontend dist: Eo({__proto__:null, default: Ja}, [I])).
function seedShape(mod) {
  const target = { __proto__: null, default: mod }
  for (const key of Object.keys(mod)) {
    if (key === 'default') continue
    Object.defineProperty(target, key, { enumerable: true, get: () => mod[key] })
  }
  return Object.freeze(Object.defineProperty(target, Symbol.toStringTag, { value: 'Module' }))
}

const code = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

const registeredSlots = []
let capturedComponent = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(options) {
        return options.factory((spec) => {
          if (spec === 'react') return seedShape(reactStub)
          throw new Error(`unexpected require: ${spec}`)
        })
      },
    },
  },
  fetch: () => { throw new Error('fetch stub') },
  console,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

const exportsShape = vm.runInContext(code, sandbox, { filename: 'lib/client.js' })
console.log('bundle exports:', Object.keys(exportsShape))

const ctx = {
  slots: {
    inject(slot, callback) {
      registeredSlots.push({ slot, callback })
      return () => {}
    },
    register(options, component) {
      capturedComponent = { options, component }
      return () => {}
    },
  },
}

exportsShape.apply(ctx)
console.log('slots.inject calls:', registeredSlots.map((r) => r.slot))
if (registeredSlots.length === 0) throw new Error('apply() did not inject settings.section')

registeredSlots[0].callback()
console.log('register options:', JSON.stringify({ ...capturedComponent.options, label: String(capturedComponent.options.label) }))
console.log('component type:', typeof capturedComponent.component, capturedComponent.component?.name)

try {
  const element = capturedComponent.component({ close: () => {} })
  if (element === null || element === undefined) {
    console.error('RENDER FAILED: component returned', element)
    process.exit(1)
  }
  if (typeof element !== 'object' || element.type === undefined) {
    console.error('RENDER FAILED: component returned a non-element:', element)
    process.exit(1)
  }
  console.log('RENDER OK: element type =', String(element.type), '| children count =', Array.isArray(element.props.children) ? element.props.children.length : 1)
} catch (error) {
  console.error('RENDER FAILED — this is what the shell turns into a blank pane:')
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
}
