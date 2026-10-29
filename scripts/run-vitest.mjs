/**
 * Standalone vitest-equivalent runner. Compiles src + tests with tsc to
 * `.build/`, then imports each compiled spec and runs its collected
 * tests via the vitest shim's `runAll()`.
 *
 * Use `node --import ./scripts/register-vitest-shim.mjs scripts/run-vitest.mjs`.
 */
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const SPECS = [
  'tests/add-connection.spec.ts',
  'tests/approval.spec.ts',
  'tests/audit.spec.ts',
  'tests/backup.spec.ts',
  'tests/build-info.spec.ts',
  'tests/cipher.spec.ts',
  'tests/client-render.spec.ts',
  'tests/config.spec.ts',
  'tests/confirm.spec.ts',
  'tests/errors.spec.ts',
  'tests/hardening.spec.ts',
  'tests/pgsql-driver.spec.ts',
  'tests/rpc-mutation.spec.ts',
  'tests/rpc-tables.spec.ts',
  'tests/safety.spec.ts',
  'tests/ssh.spec.ts',
  'tests/usage.spec.ts',
  'tests/workspaces.spec.ts',
]

console.log('[run-vitest] compiling src + tests with tsc to .build/ ...')
const tscJs = path.resolve('node_modules/typescript/lib/tsc.js')
const compile = spawnSync(
  process.execPath,
  [tscJs,
    '--outDir', '.build',
    '--module', 'nodenext',
    '--moduleResolution', 'nodenext',
    '--target', 'es2022',
    '--esModuleInterop',
    '--skipLibCheck',
    '--noEmit', 'false',
    '--declaration', 'false',
  ],
  { stdio: 'inherit' },
)
if (compile.status !== 0) {
  console.error(`[run-vitest] tsc compile failed (exit=${compile.status})`)
  process.exit(compile.status ?? 1)
}

let totalPass = 0
let totalFail = 0
const allFailures = []

// The shim is the same module instance that every spec's
// `import { describe, ... } from 'vitest'` resolves to (module cache hits the
// same URL), so we can import it once here and drive it directly.
const shimUrl = new URL('./vitest-shim.mjs', import.meta.url).href
const shim = await import(shimUrl)

for (const spec of SPECS) {
  const compiled = `.build/${spec.replace(/\.ts$/, '.js')}`
  const url = pathToFileURL(compiled).href
  console.log(`\n[run-vitest] === ${spec} ===`)
  try {
    shim.reset()
    await import(url)
    const result = await shim.runAll()
    totalPass += result.pass
    totalFail += result.fail
    for (const f of result.failures) {
      allFailures.push({ spec, ...f })
    }
    console.log(`  pass=${result.pass} fail=${result.fail}`)
    if (result.failures.length > 0) {
      for (const f of result.failures) {
        const msg = f.err?.message ?? String(f.err)
        console.log(`    ✗ ${f.name}\n      ${msg}`)
      }
    }
  } catch (e) {
    totalFail += 1
    allFailures.push({ spec, name: 'module import', err: e })
    console.error(`  failed to load: ${e?.message ?? e}`)
  }
}

console.log(`\n[run-vitest] TOTAL: pass=${totalPass} fail=${totalFail}`)
if (totalFail > 0) {
  console.log('\n[run-vitest] failures:')
  for (const f of allFailures) {
    console.log(`  ${f.spec} > ${f.name}: ${f.err?.message ?? f.err}`)
  }
  process.exit(1)
}
