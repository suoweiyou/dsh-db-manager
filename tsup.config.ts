import { defineConfig } from 'tsup'

// Host half: standard ESM plugin package entry (lib/index.js + types).
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    // Node ≥ 22.3（process.getBuiltinModule 要求；与 package.json#engines 一致）。
    // 注意：tsup 内置 node-protocol 插件会把所有 node:* 静态导入改写成裸名
    // （external 也拦不住），而 node:sqlite 没有裸名别名 —— 因此
    // src/db/sqlite-driver.ts 必须用 process.getBuiltinModule 取模块，
    // 不能用静态 import。
    target: 'node22',
    platform: 'node',
    external: ['mysql2', 'zod', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery'],
    outDir: 'lib',
    clean: true,
  },
  // Client half: bundled as a ModuleLoader module for the DSH browser runtime.
  // External deps (react, react-dom) are resolved through the loader's require.
  {
    entry: { client: 'src/client/main.ts' },
    format: ['cjs'],
    outExtension: () => ({ js: '.js' }),
    platform: 'browser',
    target: 'es2021',
    sourcemap: true,
    dts: false,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "dsh-db-manager", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
    },
    footer: {
      js: 'return module.exports; } });',
    },
    outDir: 'lib',
  },
])
