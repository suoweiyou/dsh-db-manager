/**
 * Preload script that registers the vitest shim loader with Node's module
 * resolution. Use with: `node --import ./scripts/register-vitest-shim.mjs ...`
 */
import { register } from 'node:module'
register('./vitest-loader.mjs', import.meta.url)
