# dsh-db-manager 变更记录 v0.13（设置页「查看表」）

**变更日期**: 2026-09-14
**前置版本**: v0.12.1
**本文定位**: 设置页「数据库」分区新增只读表浏览能力——列出某连接默认库的全部表/视图，并按表查看列/索引/DDL；不提供任何读取数据行的入口。上一区间见 [CHANGELOG-v0.12-安全加固.md](./CHANGELOG-v0.12-安全加固.md) / [CHANGELOG-v0.12.1-启动修复.md](./CHANGELOG-v0.12.1-启动修复.md)。

## 一句话总览

| 项 | 类型 | 主题 | 用户感知 |
|----|------|------|---------|
| 新功能 | feature | 设置页连接卡新增「查看表」入口 | 在设置页「数据库」分区可逐张浏览某连接默认库中的表/视图，并按表查看列、索引与 DDL（只读） |
| 新增 RPC | feature | `tables.list` / `tables.describe` | 后端新增两个 token 鉴权 RPC，承载上述只读元数据查询 |
| 新增测试 | test | `tests/rpc-tables.spec.ts`（6 例） | 覆盖两个新 RPC 的成功与配置/不存在表等失败路径 |

## 背景与动机

PRD §1.2 明确"管理面（GUI）承担连接管理——查看已配置的数据库连接与状态、增增改、连通性测试、默认连接设置"；§11（非目标）又明确"数据面 GUI（库表树浏览、数据网格、SQL 控制台、数据导出 UI）由模型工具承担"。本次新增的"查看表"介于两者之间：行为是只读元数据浏览、入口在设置页，但严格不触碰数据行，定位仍是设置页「数据库」分区内的"连接管理延伸视图"，而不是引入数据面 GUI。

## 设计与实现

### 数据通道：复用现有工具的同源 driver 路径

新增的两个 RPC（`tables.list` / `tables.describe`）复用 `src/db/metadata.ts` 的方言实现（`listTables` / `describeTable`），即 AI 侧 `db_list_tables` / `db_describe_table` 工具同款 driver 路径——意味着：

- 三方言（MySQL / PostgreSQL / SQLite）行为一致；
- 池复用、SQLite 路径沙箱每次 acquire 重跑、realpath 解析、规格指纹缓存等既有安全/正确性保证自动生效；
- 不引入新的 SQL 分支（开发规范 §2 方言收敛）。

### RPC 层（src/rpc/routes.ts）

`RpcDeps` 扩展两个字段：`queryTimeoutMs`、`pools`。新增可测试的 helper：

- `resolveSpecForRpc(store, name)`——按连接名查 spec（与 GUI 测试按钮同源 lookup）；
- `browseTablesForRpc(store, rt, name, databaseOverride?)`——列表，SQLite 用 `process.cwd()` 作为 `allowedRoots` 兜底（与 `testConnection` 的 GUI 按钮同约定）；
- `describeTableForRpc(store, rt, name, table, databaseOverride?)`——单表结构（列 / 索引 / DDL）。

路由层新增两个 case：

- `tables.list { name, database? }` → `{ ok, connection, dialect, database, tables[] }`，错误返回 422（config 错误）或 502（运行时错误），并写审计 `tables.list` 条目；
- `tables.describe { name, table, database? }` → `{ ok, connection, dialect, database, table, columns[], indexes[], ddl? }`，同上。

**关键修复**：第一次实现里在 `finally` 中调用了 `driver.end()`，导致池缓存的 driver 被关闭、第二次 `acquire` 拿到已关闭的连接、随后 `prepare()` 抛"database is not open"。按 §6.1 规范"安全修复必须补回归用例"对应去除 `end()` 调用——driver 由 PoolManager 拥有，调用方不释放。

### 客户端（src/client/Section.ts）

`Section.ts`（React + createElement）新增三块：

1. **连接卡操作按钮**——新增「查看表 / 收起表」按钮（与「测试」「编辑」「删除」同一行），按下展开面板；
2. **`BrowseState` 联合**——`idle | list | { phase: 'list', loading, tables?, error? } | { phase: 'describe', loading, database, table, describe?, error? }`，按 `connection name` 存于 `Record<string, BrowseState>`；
3. **`browsePanel` / `DescribeView` / `renderColumnRow` / `renderIndexRow`**——列表视图：每张表一行 `[查看 DDL] <name> [表/视图] —— <comment>`；点击「查看 DDL」切到 describe 视图，列出列、索引，DDL 走 `<pre>` 等宽字体块展示。

底部说明文字追加一句："点击卡片上「查看表」可在浏览器中浏览某连接默认库的表清单与 DDL（只读，不会触碰数据行）"。

### 类型（src/client/api.ts）

新增 `TableListItem` / `TablesListResponse` / `TableColumnView` / `TableIndexView` / `TableDescribeResponse`——纯展示类型，与 `db_list_tables` / `db_describe_table` 工具返回结构对齐，方便后续同步调整。

## 测试

新增 `tests/rpc-tables.spec.ts`（6 例）：

1. `returns a config failure when the connection name is missing` —— 入参 `name` 空 → 422 + 提示语；
2. `returns a config failure when the connection does not exist` —— 连接名拼错 → 422；
3. `returns a config failure when no database is resolvable` —— MySQL 连接既无 `defaultDatabase` 又未传 `database` → 422；
4. `lists tables + DDL via the SQLite driver for a :memory: connection` —— 通过 pool seed `:memory:` 然后走真实 `browseTablesForRpc` + `describeTableForRpc`，验证表清单、列顺序、nullable、DDL 内容；
5. `returns a config failure when describing a table that does not exist` —— 空 `:memory:` 库 describe 任意表 → config + "no_such_table … 不存在"；
6. `returns a config failure when the table parameter is empty` —— 入参 `table` 空 → 422 + 提示语。

## 文件变更清单

| 类型 | 路径 | 说明 |
|------|------|------|
| 代码 | `src/rpc/routes.ts` | `RpcDeps` 加 `pools` + `queryTimeoutMs`；新增 `resolveSpecForRpc` / `browseTablesForRpc` / `describeTableForRpc`；新增两个 RPC case |
| 代码 | `src/index.ts` | 把 `pools` + `queryTimeoutMs` 注入 `RpcDeps` |
| 代码 | `src/client/api.ts` | 新增 `TableListItem` / `TablesListResponse` / `TableColumnView` / `TableIndexView` / `TableDescribeResponse` |
| 代码 | `src/client/Section.ts` | 新增 `BrowseState`、`browseOpen` / `browseSelectTable` / `browseBack` / `browseClose` handlers、`browsePanel` / `DescribeView` / `renderColumnRow` / `renderIndexRow` 渲染；卡片操作行新增「查看表」按钮 |
| 测试 | `tests/rpc-tables.spec.ts` | 新增 6 例 RPC 表浏览 helper 测试 |
| 脚本 | `scripts/run-vitest.mjs` | `SPECS` 列表新增 `tests/rpc-tables.spec.ts`（11 → 12 spec，133 → 139 测试） |
| 脚本 | `scripts/build-sandbox.mjs` | **新增**沙箱内构建脚本：DSH 沙箱禁止 esbuild spawn（§5.2），`npm run build` 在沙箱内静默失败；本脚本纯 TypeScript API 编译产出 `lib/`（host 多文件 ESM + client 单文件 CJS + ModuleLoader wrapper） |
| 文档 | `docs/开发规范.md` | §5.2 补充 tsup/esbuild 沙箱限制与 `build-sandbox.mjs` 用法；§8 命令速查加一行 |
| 文档 | `docs/PROJECT.md` | 第 7 节变更日志索引追加一行 |
| 文档 | `docs/CHANGELOG-v0.13-GUI查看表.md` | 本文件 |
| 文档 | `docs/需求设计文档.md` | §5.1 GUI 线框与 §5.2 RPC 协议追加新方法 |
| 文档 | `README.md` | 功能亮点 / 文档导航附录同步 |

## 排障记录 2：重启 DSH 报 "loaded without registering"（2026-09-14）

**现象**：用户重启 DSH 后启动失败：`failed to import loader entry (dsh-db-manager): client-modules: bundle … loaded without registering "dsh-db-manager" via __ModuleLoader__.load`。

**根因（两个 bug 叠加，均出自 `scripts/build-sandbox.mjs` 首版拼接模板）**：

1. **语法错误**：模块注册表被拼成 `var __dbm_modules = {};` 后跟裸的 `'api': …` 属性名——属性名出现在语句位置，整个 bundle parse 失败，任何代码（包括 `__ModuleLoader__.load`）都不执行。
2. **求值顺序错误**：第一处修复后（对象字面量形式 `var __dbm_modules = { 'api': IIFE, … }`）仍失败——对象字面量**先求值全部属性值、后才赋给变量**，`Section` 模块的 IIFE 在 `__dbm_modules` 尚未赋值时执行其内部 `const { rpc } = __dbm_modules['api']`，抛 TypeError。

**修复**：
1. 注册表改为**逐条赋值语句**（`__dbm_modules['api'] = IIFE; __dbm_modules['Section'] = IIFE; …`），语句顺序执行，api → Section → main 的赋值次序与 import 方向一致。
2. `build-sandbox.mjs` 增加**双门禁**，坏产物永远写不出：
   - **语法门**：`new vm.Script(bundle)` —— parse 失败即 exit 1；
   - **运行时门**：在 `node:vm` 沙箱中用 stub ModuleLoader 真实执行 bundle，断言注册契约（`id === 'dsh-db-manager'`、exports 含 `apply` 函数 + `inject` 字符串数组）——不满足即 exit 1。
3. 新增 `scripts/smoke-client.mjs` 独立冒烟脚本（`node scripts/smoke-client.mjs`），可在任意时刻复核已部署的 `lib/client.js`。

**验证**：构建门禁输出 `client gate OK: registered "dsh-db-manager" exports=[apply, inject] inject=["slots"]`；独立冒烟同过；vitest 回归 139/139。

**教训**：拼接式 bundler 每次修改模板都必须「语法 parse + 运行时注册契约」双重验证——仅检查文件存在与字符串匹配（grep「查看表」）不足以发现语法/求值顺序错误。

## 排障记录 3：插件加载成功但设置页「数据库」分区空白（2026-09-14）

**现象**：重启 DSH 无报错（注册契约通过），但设置页「数据库」分区点开是空白。

**根因（第三个 bug，仍出自拼接模板）**：`toCjsBody` 处理**别名导入**时丢弃了 imported 名——

```js
// 源码: import { createElement as h, … } from 'react'
// 正确: const { createElement: h, … } = require('react')
// 实际: const { h, … } = require('react')   ← h === undefined
```

组件渲染时 `h(...)` 抛 `TypeError: h is not a function`，被 shell 吞掉呈现空白。前两道门（语法 parse + 注册契约）都抓不到它——因为 bug 只在 **React 调用组件时**爆炸，load/apply 阶段一切正常。

**复现方法**：`node scripts/render-client.mjs`（新增）——vm 加载 bundle（seed 形状 react stub：frozen null-proto namespace + default + getter named exports，与 dsh-web-frontend 的 seed 构造一致）→ apply → 取出注册组件 → 以 mini hooks runtime 同步调用，等价于 shell 渲染该分区；修复前输出 `TypeError: h is not a function`。

**修复**：
1. `toCjsBody` 的 import 映射保留 `imported: local`（`createElement: h`）。
2. `build-sandbox.mjs` 运行时门升级为**渲染门**：apply → slots 注册 → 以 mini hooks + createElement stub 同步调用组件，断言 createElement 被调用且组件不抛错——渲染期才炸的 bug 从此出不了门。

**验证**：构建门禁 `render=(8 createElement calls)`；`scripts/render-client.mjs` 用真实 React createElement 输出 `RENDER OK: element type = div | children count = 3`。

**教训**：客户端 bundle 的门禁必须覆盖完整生命周期——语法 → 注册契约 → **组件渲染**——缺最后一层时，所有"渲染期才爆炸"的 bug 都会静默上屏为空白。

## 排障记录 1：刷新后看不到「查看表」按钮（2026-09-14）

**现象**：v0.13 功能实现后，用户在 DSH 设置页刷新看不到「查看表」按钮。

**根因**：`npm run build`（tsup）在 DSH 沙箱内被静默拒绝（esbuild 需要 spawn 子进程，沙箱报 `spawn EPERM` / Access denied），`lib/client.js` 停留在旧版本（源码修改前的时间戳），用户刷新页面加载的仍是旧产物。

**验证方法**：`Select-String -Path lib/client.js -Pattern '查看表'` 无匹配 = 产物过期；`Get-Item lib/client.js | Select-Object LastWriteTime` 早于 `src/client/*.ts` 的修改时间也是同一信号。

**处置**：
1. 新增 `scripts/build-sandbox.mjs`——纯 TypeScript API（`ts.createProgram` / `ts.transpileModule`）编译，不需要 esbuild 子进程，可在沙箱内运行；产出 host 多文件 ESM + client 单文件 CJS。
2. 开发规范 §5.2 补充该限制与处置。
3. 重新构建后 `lib/client.js` 已包含「查看表」逻辑（31319 字节），Node 加载 `lib/index.js` 验证 exports 完整。

## 安全复查（2026-09-14，增量）

按开发规范 §4「涉及安全面的变更应主动复查」对本轮新增代码做了系统走查，完整记录见 [records/安全审计-v0.13-查看表.md](records/安全审计-v0.13-查看表.md)。结论：**高危 0 · 中危 0**；低危/缺陷 2 项同轮修复，加固 1 项同轮实施，已知边界 4 项记录在案。

| 编号 | 类型 | 位置 | 问题 | 处置 |
|------|------|------|------|------|
| L1 | 功能缺陷 | `rpc/routes.ts` openForBrowse | `connectTimeoutMs` 误传为 `queryTimeoutMs`，不可达连接要等 15s 才报错 | `BrowseRuntime` 增加 `connectTimeoutMs`，两个 case 传入 `deps.connectTimeoutMs` |
| L2 | UX bug | `client/Section.ts` browseBack | 从 DDL 视图返回表列表时丢失已加载清单，显示「该库没有表或视图」 | describe 状态携带 `tables`，`browseBack` 原样恢复 |
| H1 | 加固 | `rpc/routes.ts` tables.* case | 错误出口未经 `sanitize()` 打码（外层 catch 有、分支内没有） | 统一 `sanitize(outcome.failure?.message ?? '未知错误')` |

**第二轮复查（部署排障与主题修复后）**——完整记录见 [records/安全审计-v0.13-查看表.md](records/安全审计-v0.13-查看表.md) 附章：

| 编号 | 类型 | 位置 | 问题 | 处置 |
|------|------|------|------|------|
| B1 | 功能 bug | `client/Section.ts` 卡片操作行 | 「收起表」按钮点击行为是重新拉取而非收起（共用 onBrowse） | onClick 按状态切换收起/展开（注意组件内 async 回调遮蔽模块级判定函数的作用域陷阱） |
| B2 | 竞态 | `client/Section.ts` browseOpen / browseSelectTable | 慢响应覆盖新状态：收起后迟到响应复活面板；表 A 慢 describe 覆盖表 B | 响应回写加 stale 检查（key 存在性 / phase+table+database 一致性） |
| H2 | 加固 | `rpc/routes.ts` tables.* case | `hint` 出口未打码（H1 只覆盖了 message） | hint 与 message 同标准过 `sanitize()` |

另：DDL `<pre>` 背景从硬编码 `#1a1a1a` 改为主题变量 `C.card`，修复浅色主题下黑底深字不可见。

安全面确认通过：SQL 注入面（参数化 + quoteIdentifier 白名单）、RPC 鉴权（统一 token + 常量时间比较）、密码零出口、XSS（纯 React children）、SQLite 沙箱（每次 acquire 重校验）、审计双分支留痕、driver 生命周期（不再误关缓存连接）、queryTimeoutMs 兜底（N4）。

## 运行验证（§5.1 矩阵）

| 验证层 | 命令 | 结果 |
|--------|------|------|
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | ✅ 无输出 |
| vitest 全套 | `node --import ./scripts/register-vitest-shim.mjs scripts/run-vitest.mjs` | ✅ 139/139（12 spec，含新增 `tests/rpc-tables.spec.ts` 6 例） |
| 核心逻辑 | `node scripts/verify.mjs` | ✅ 59/59 |
| tsup 构建 | `node node_modules/tsup/dist/index.js` | ✅ 生成 `lib/index.js`、`lib/index.d.ts`、`lib/client.js` |

## 已知边界（记录在案，非漏洞）

1. **GUI 不直接选取数据库**：浏览器面板只能查看连接 `defaultDatabase`，未提供切换其它库的入口——这是 §11"非目标"的边界守卫（GUI 不承接数据浏览面），避免悄悄演化为库选择器 → 数据面 GUI。
2. **SQLite 路径沙箱**：浏览器面板打开 SQLite 文件时 `allowedRoots = [process.cwd()]`，与 GUI「测试」按钮同约定——`~/.dsh/db-manager/audit/` 会记录 `tables.list` / `tables.describe` 的 SQLite 操作，便于事后核对是否打开了非预期文件。
3. **DDL 一致性**：MySQL / SQLite 返回真实保存的 DDL；PostgreSQL 返回按系统目录 best-effort 重建的 `CREATE TABLE` 骨架（列名 + 类型 + NOT NULL），与 `db_describe_table` 工具一致——约束/索引文本可能不完整，由 `db_describe_table` 工具的同名输出对齐。
4. **驱动缓存复用**：本次 RPC 不在 `finally` 调用 `driver.end()`，确保同连接名 / 同文件路径 / 同规格指纹的下一次请求复用同一 driver（审计 N2 同款契约）；副作用：连接删除后必须等待下次 `retainOnly` 或重启才会真正关闭底层句柄。
5. **错误归类**：列表 / 描述类错误按 §5.3 协议映射到 `DbErrorKind`（network / auth / unknown-database / permission / timeout / syntax / config / unknown），HTTP 状态码 config 错误用 422、其他用 502，与既有 RPC 一致。