/**
 * Node module loader hook that redirects any `import ... from 'vitest'`
 * in the compiled spec files to our shim implementation. This is how we
 * run vitest specs with plain Node when the sandbox blocks the esbuild
 * subprocess vitest normally spawns.
 *
 * Activated via `node --import ./scripts/register-vitest-shim.mjs ...`.
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SHIM_URL = new URL('./vitest-shim.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vitest') {
    return { url: SHIM_URL, shortCircuit: true, format: 'module' }
  }
  return nextResolve(specifier, context)
}

