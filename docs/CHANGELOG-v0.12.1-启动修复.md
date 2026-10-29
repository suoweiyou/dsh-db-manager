# dsh-db-manager 变更记录 v0.12.1（启动修复：node:sqlite 被打包改写）

**变更日期**: 2026-09-14
**前置版本**: v0.12
**本文定位**: 修复插件挂载后 DSH 启动即失败——打包产物把 `node:sqlite` 静态导入改写为不存在的裸名 `"sqlite"`。上一区间见 [CHANGELOG-v0.12-安全加固](./CHANGELOG-v0.12-安全加固.md)。

---

## 一句话总览

| 项 | 严重度 | 主题 | 用户感知 |
|---|---|---|---|
| B1 | 高（阻断启动） | `node:sqlite` 静态导入被 tsup 改写为裸名 `"sqlite"` | 修复后插件正常加载，`dsh web` 可启动 |

---

## 1. B1 — 现象与根因

**现象**：`dsh web` 启动即退出：

```text
Error: dsh: plugin tree failed to load: failed to import loader entry db-manager (dsh-db-manager):
Cannot find package 'sqlite' imported from <plugin>\lib\index.js   (ERR_MODULE_NOT_FOUND)
```

同屏的 `[dsh-task-board] ... cannot get required service "typert" in inactive context` 是插件树加载失败后的连带症状（宿主上下文未激活），非独立问题，修复后消失。

**根因链**：

1. 源码正确：`import { DatabaseSync } from 'node:sqlite'`（Node 22+ 内置模块）。
2. tsup 内置 `node-protocol-plugin`（`node_modules/tsup/dist/index.js`）把**所有** `node:*` 静态导入无条件下重写为裸名（剥前缀 + external），且无配置项可关；esbuild 本体（0.27.7）实测不剥离（CLI 直跑两种 target 均保留 `node:sqlite`）。
3. Node 内置模块中**唯独 `sqlite` 没有裸名别名**（`fs`/`path`/`crypto` 等裸名均可解析，`sqlite` 不可）——所以只有它炸。
4. `external: ['node:sqlite']` 与 target 升至 `node22` 均无效：重写发生在 tsup 插件层，先于 esbuild external 匹配。

## 2. 修复（源码层绕开导入改写）

- `src/db/sqlite-driver.ts`：静态导入改为运行时获取——`const { DatabaseSync } = process.getBuiltinModule('node:sqlite')`（Node 22.3+；普通函数调用，任何打包器都不会改写），并留注释防止回退成静态 import。
- `tsup.config.ts`：`target` node20 → node22（与 engines 对齐），注释记录该陷阱。
- `package.json`：`engines.node` `>=22.0.0` → `>=22.3.0`（`process.getBuiltinModule` 可用性）。
- 产物验证：`lib/index.js` 对应行为 `var { DatabaseSync } = process.getBuiltinModule("node:sqlite")`，全文件无 `"sqlite"` 裸名导入；`node --input-type=module -e "await import('…/lib/index.js')"` → **IMPORT OK**。

## 3. 运行验证

| 验证层 | 结果 |
|---|---|
| `tsc --noEmit` | ✓ |
| vitest shim runner（11 spec） | ✓ 133/133 |
| `lib/index.js` 模块图冒烟 import | ✓ IMPORT OK |

## 4. 经验沉淀（写入注释，防回归）

1. 本仓库内凡 Node 内置模块**没有裸名别名**的（当前仅 `node:sqlite`），必须用 `process.getBuiltinModule('node:xxx')` 取用，禁止静态 import。
2. 每次构建后建议跑模块图冒烟：`node --input-type=module -e "await import('file:///<插件目录>/lib/index.js')"`，确认导入形态未被改写。
