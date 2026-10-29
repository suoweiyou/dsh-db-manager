# AGENTS.md — AI 编码助手入口

> 本文件供在本仓库工作的 AI 助手（DSH / Claude Code / Cursor / Copilot 等）在**动手之前**读取。
> 它只是入口与速查：**与 [`docs/开发规范.md`](docs/开发规范.md) 冲突时，一律以开发规范为准。**

## 1. 动手前必做

**第一步：完整读一遍 [`docs/开发规范.md`](docs/开发规范.md)。** 读完再动代码——里面是安全红线（违反即返工）和变更日志强制规则。

**第二步：按任务补读**

| 你要做的事 | 必须先读 |
|---|---|
| 加功能 / 改 RPC、工具协议 / 改 GUI | [`docs/需求设计文档.md`](docs/需求设计文档.md)——需求与协议的唯一权威 |
| 摸清全局、查历史决策与既有结论 | [`docs/PROJECT.md`](docs/PROJECT.md)——文档地图 + 变更日志索引 |
| 碰安全面（密码 / SQL 网关 / 沙箱 / 审计 / 令牌） | 开发规范 §4 + `docs/records/` 里对应的审计报告 |
| 发布、上架插件市场 | [`docs/发布指南-插件市场.md`](docs/发布指南-插件市场.md) |

**第三步：先说明再动手。** 用一两句说清「要改哪些文件、为什么、怎么验证」，然后再改。遇到推断不出的路径、地址、端口、名称，先问，不要猜。

## 2. 项目一句话

DSH 双端 Cordis 插件：MySQL / PostgreSQL / SQLite 连接注册中心 + 设置页管理 GUI + 9 个 `db_*` 模型工具。Host 半区是 ESM（`src/index.ts` → `lib/index.js`），Client 半区是 CJS ModuleLoader 模块（`src/client/main.ts` → `lib/client.js`）。

## 3. 硬约束速查（完整条款见开发规范 §1 / §2 / §4）

- **技术栈**：TypeScript 5 strict + ESM；Node ≥ 22.3（`node:sqlite`、`process.getBuiltinModule` 要求）；目标宿主 DSH `^0.2.1-alpha.2`（只跟随 0.2.1 线）。
- **DSH 兼容变更必须发版打 tag 并建 Release**：`package.json#version`、git tag、Release 正文里的 DSH 版本矩阵三者必须一致；只给实测通过的版本打 stable tag（详见开发规范 §7.2）——用户靠它按自己的 DSH 版本装对应插件。
- **依赖白名单**：运行依赖只有 `mysql2` / `pg` / `zod` / `node-sql-parser` / `ssh2`；`@deepseek-ai/*` 一律进 `peerDependencies`；**禁止 native binding 依赖**（SQLite 用 Node 内置 `node:sqlite`）。要加新依赖先问。
- **方言收敛**：数据库差异只允许出现在 `src/db/dialect.ts` 与三个 driver 文件；工具 / RPC / GUI 代码**不得出现** `if (spec.dialect === …)` 形式的业务分支（GUI 只允许徽章与表单字段切换）。
- **密码**：配置里只允许 `$ENV:VAR` 引用或 `enc:v1:` AES-256-GCM 密文；任何出口（工具返回 / RPC / 日志 / 错误文案 / GUI）不得出现明文密码、完整连接串或值片段。
- **执行文本必须是调用方原文**：`node-sql-parser` 的 `sqlify` 只能用于往返复核，绝不可作为执行语句或令牌绑定文本（它会把 PG 的引号写成 MySQL 反引号——v0.14.1 的真实故障）。
- **SQLite 路径沙箱**：`validateSqliteFilePath` 每次 acquire 都要重跑（fail-closed）+ realpath 解析 + `root + path.sep` 防前缀攻击；不得放宽为「建池时校验一次」。
- **文案**：面向用户的错误信息、工具描述、GUI 文案一律中文；错误信息不得含凭据片段。

## 4. 沙箱内可用的命令（照抄，别用 `npm run`）

| 用途 | 命令 |
|---|---|
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` |
| 单测（vitest 全套） | `node --import ./scripts/register-vitest-shim.mjs scripts/run-vitest.mjs` |
| 构建 `lib/` | `node scripts/build-sandbox.mjs` |
| 核心逻辑验证 | 先按开发规范 §5.1 把 `tsc` 输出到 `.build/`，再 `node scripts/verify.mjs` |

⚠️ `npm run build` / `npm test` 在 DSH 沙箱内**不可用**（esbuild spawn EPERM），且构建失败可能是**静默的**——改完代码看不到效果时，先怀疑构建没跑成。改 Host 半区需重启 DSH，改 Client 半区刷新页面即可。

## 5. 改动收尾（强制，见开发规范 §6.1）

1. 在 [`docs/PROJECT.md`](docs/PROJECT.md) 的「变更日志（索引）」追加一行：`版本区间 | 日期 | 主题 | 类型 | 一句话说明 | 详情链接`——**任何变更都要**。
2. **只有代码/发版变更**（`src/`、`tests/`、`bin/`、`scripts/`、`package.json`、`cordis.patch*.yml` 有改动，或发布新版本）才新建/更新 `docs/CHANGELOG-v<版本>-<主题>.md`，套用开发规范 §6.1 的模板；**纯文档/流程变更（README、AGENTS.md、`docs/*.md`）不建 CHANGELOG**，详情链接填 `本提交说明`。
3. 代码变更把 §5.1 验证矩阵结果写进 CHANGELOG 的「运行验证」小节。
4. 文档只保留**单一最终版**，不写版本对比；`CHANGELOG-*` 只增不改史；`docs/records/` 不改写既有事实。

## 6. 不要做

- ❌ 手工编辑 `lib/`（构建产物，已被 `.gitignore` 忽略）——只改 `src/`，然后重新构建。
- ❌ 自动 `git commit` / `git push`：本项目的提交与推送由所有者执行；需要时只**准备**提交信息（Conventional Commits + 中文正文）。
- ❌ 把真实主机、IP、账号、客户名、本机绝对路径写进仓库；示例统一用 RFC 5737 网段（`203.0.113.0/24`、`198.51.100.0/24`），测试夹具用假值。
- ❌ 在没有实测的情况下改动 DSH 版本声明（`dsh.engines.dsh` 与三个 `@deepseek-ai/dsh-*` 的 peer 区间）。
- ❌ 顺手重构任务范围之外的代码。

## 7. 交付前自检

- [ ] 类型检查、单测、核心验证全绿（开发规范 §5.1）
- [ ] 新增或修改的行为有测试；安全修复带回归用例（引用审计编号）
- [ ] PROJECT 索引行已更新；代码/发版变更另有 CHANGELOG（纯文档变更不需要）
- [ ] 没有明文凭据、没有真实地址、没有 `lib/` 手工改动
- [ ] 提交信息已准备好（但未自动提交）
