# PROJECT：dsh-db-manager

**一句话**: DeepSeek Harness（DSH）双端 Cordis 插件——多方言（MySQL / PostgreSQL / SQLite）数据库连接注册中心 + 设置页管理 GUI + 安全的 AI 数据查询工具。
**当前版本**: v0.12.1（启动修复）｜ **仓库**: https://gitee.com/<account>/dsh-db-manager.git（`origin-gitee`，分支 `master`）｜ **许可**: MIT

---

## 1. 项目简介

dsh-db-manager 让 DSH 会话中的 AI 与开发者共享同一份多项目数据库连接：

- **管理面（GUI）**：DSH 设置页「数据库」分区——连接卡片（方言徽章、读写模式、状态点绿/灰/红）、添加/编辑/删除/单测/全部测试、会话与工作区使用关联明细；配置变更即保存即生效。
- **数据面（AI 工具）**：9 个 `db_*` 模型工具覆盖连接注册（`db_add_connection` 一句话加库：校验 + 写配置 + 连通性测试）、连接发现、连通测试、库/表/结构元数据、只读查询（白名单 + 自动 LIMIT + 截断 + 总数估计）与受控写执行（影子备份 + 高危确认闭环）。
- **安全**：密码在配置文件中仅存 `$ENV:VAR` 引用或 AES-256-GCM 密文（文件内明文 schema 层拒绝）；工具入参的明文密码由 Host 即时加密后落盘；SQL 安全网关（AST 分类 + 规则层 + 规范化复核）；宿主人工审批 / HMAC 确认令牌双通道；全程 JSONL 审计脱敏；默认只读。
- **形态**：npm 包（Host 半区 ESM 插件 + Client 半区 ModuleLoader 模块），composition 一行同挂双端；零 native binding（SQLite 走 Node 22+ 内置 `node:sqlite`），部署仅要求 Node ≥ 22。

## 2. 核心能力速览

| 能力 | 入口 | 说明 |
|------|------|------|
| 连接管理 GUI | 设置页 → 数据库 | 三个标签页：「全局连接」（卡片/状态/增删改/测试）+「项目」（项目列表、项目私有连接增删改、项目用过的全局连接只读）+「SSH 配置」（可复用跳板机配置增删改）；搜索过滤；RPC `/db-manager/api/*` + `x-dbm-token` |
| SSH 隧道（FR-13） | 连接的 `sshProfile` | 连接可引用可复用的 SSH 配置；先连跳板机再经隧道连数据库；支持 agent/私钥文件/内联私钥/密码；**主机密钥严格校验**（known_hosts 缺失即拒连）；本地转发只绑 127.0.0.1；隧道随连接池条目关闭 |
| 连接注册 | `db_add_connection` | 一次调用完成校验 + 写配置（global/workspace）+ 连通性测试；明文密码即时加密落盘；同名默认拒绝，`replace: true` 更新 |
| 连接与元数据 | `db_list_connections` `db_test_connection` `db_reload_config` `db_list_databases` `db_list_tables` `db_describe_table` | 三方言行为一致 |
| 只读查询 | `db_query` | 白名单、LIMIT 注入/收口、截断 + COUNT 估计 |
| 受控写 | `db_execute` | 备份策略三档（默认 small-only）、事务化影子备份、高危确认闭环 |
| 审计 | `~/.dsh/db-manager/audit/*.jsonl` | 按天滚动 30 天、凭据打码、GUI 变更同样留痕 |

## 3. 文档地图

| 文档 | 定位 |
|------|------|
| [../AGENTS.md](../AGENTS.md) | **AI 助手入口**：动手前必读清单、硬约束速查、沙箱命令、改动收尾规则（规范全文仍以开发规范为准） |
| [需求设计文档.md](需求设计文档.md) | **唯一权威**：背景定位、目标与衡量、场景、FR 清单、GUI/RPC/工具协议、技术方案、演进专题（多方言/备份策略/node:sqlite）、安全设计与审计结论、里程碑与验收、配置使用速查 |
| [开发规范.md](开发规范.md) | 技术栈、工程结构、编码规范、安全红线、测试验证矩阵、**变更日志强制规则**、Git/发布规范 |
| [PROJECT.md](PROJECT.md) | 本文件：项目总览、文档地图、验证基线、变更日志索引 |
| [CHANGELOG-v0.1-v0.6.md](CHANGELOG-v0.1-v0.6.md) | 首日全链路：PRD 四轮迭代、M2–M4 里程碑、两轮安全审计 |
| [CHANGELOG-v0.7-v0.11.md](CHANGELOG-v0.7-v0.11.md) | 多方言（PG/SQLite）、安全审计 v0.9、备份策略 v0.10、node:sqlite 迁移 v0.11 |
| [CHANGELOG-v0.12-安全加固.md](CHANGELOG-v0.12-安全加固.md) | 二轮复查 N1–N10 全处置 |
| [发布指南-插件市场.md](发布指南-插件市场.md) | GitHub 仓库 → npm 发布 → awesome-dsh-plugin 目录收录全流程 |
| [records/PRD-dsh-db-manager-评审纪要.md](records/PRD-dsh-db-manager-评审纪要.md) | PRD v0.2→v0.4 三次评审记录（通过） |
| [records/代码安全审计报告.md](records/代码安全审计报告.md) | 第一轮代码安全审计（高2/中7/低11，含修复记录） |
| [records/安全审计-2026-09-09.md](records/安全审计-2026-09-09.md) | INTO OUTFILE / USE / SET 等专项审计（7 项修复） |
| [records/安全审计-复查-新增发现.md](records/安全审计-复查-新增发现.md) | 多方言后增量复查（N1–N10，v0.12 已处置） |
| [records/安全审计-v0.13-查看表.md](records/安全审计-v0.13-查看表.md) | v0.13「查看表」增量复查（0 高/中危，L1/L2 同轮修复，H1 加固） |
| [records/迭代日志.md](records/迭代日志.md) | 2026-09-09 ~ 09-14 逐条迭代日志（原始留痕） |

## 4. 工程信息

| 项 | 值 |
|----|-----|
| 插件包名 | `dsh-db-manager`（ESM；`dsh.bundle.patch: ./cordis.patch.yml`；`dsh.client` 浏览器半区） |
| 运行时要求 | Node ≥ 22.3（DSH 主进程，`process.getBuiltinModule` 要求）；DSH ≥ 0.2.1-alpha.2（**只跟随 0.2.1 线**，见 README「兼容性：支持的 DSH 版本」） |
| 运行依赖 | mysql2 / pg / zod / node-sql-parser（SQLite 走 `node:sqlite`，零 native binding） |
| 构建 | `npm run build`（tsup → `lib/index.js` + `lib/client.js`）；产物 `lib/` 不入库 |
| 测试 | vitest 12 spec（沙箱内经 `scripts/run-vitest.mjs` shim runner）；`scripts/verify.mjs` 核心验证；`tests/integration/mysql.spec.ts` 以 `DBM_TEST_URL` 门控 |
| 沙箱构建 | `node scripts/build-sandbox.mjs`（`npm run build` 的沙箱内替代；tsup/esbuild 需要 spawn，沙箱内静默失败，见开发规范 §5.2） |
| 关键脚本 | `bin/encrypt.js`（`enc:v1` 密文离线生成） |

## 5. 里程碑状态

| 里程碑 | 状态 |
|--------|------|
| M1 需求评审（PRD 通过） | ✅ 2026-09-09 |
| M2 插件骨架 + 连接管理（双端包/配置/池/RPC/GUI/基础工具） | ✅ 2026-09-09 |
| M3 元数据与查询 + 安全网关 | ✅ 2026-09-09 |
| M4 加固（审计/集成测试/三轮安全审计） | ✅ 2026-09-09 ~ 09-14 |
| M5 发布（npm / GitHub / 目录收录） | 🔶 文档与要件就绪，发布动作待办（见发布指南） |

## 6. 验证基线（当前 v0.13）

| 验证层 | 命令 | 结果 |
|--------|------|------|
| 类型检查 | `tsc --noEmit` | ✅ |
| vitest 全套 | `node --import ./scripts/register-vitest-shim.mjs scripts/run-vitest.mjs` | ✅ 139/139（12 spec，含 v0.13 新增 `tests/rpc-tables.spec.ts` 6 例） |
| 核心逻辑 | `node scripts/verify.mjs` | ✅ 59/59（含真实 node:sqlite 集成） |
| MySQL 真库集成 | `DBM_TEST_URL=… npm run verify` | ⬜ 待本机执行 |

## 7. 变更日志（索引）

> **规则**（详见 [开发规范.md §6](开发规范.md)）：每次变更完成后，必须在本表追加一行摘要，并在 `docs/CHANGELOG-<版本或区间>-<主题>.md` 中记录全部细节。变更细节只增不改史。

| 版本区间 | 日期 | 主题 | 类型 | 一句话说明 | 详情 |
|----------|------|------|------|-----------|------|
| v0.1 – v0.6 | 2026-09-09 | PRD 四轮迭代 + M2–M4 交付 + 两轮安全审计 | feature/security | 项目启动日：PRD 评审通过，双端插件/连接管理 GUI/元数据查询/安全网关/审计全链路交付，两轮审计修复 2+7+7 项 | [CHANGELOG-v0.1-v0.6.md](CHANGELOG-v0.1-v0.6.md) |
| v0.7 – v0.11 | 2026-09-13 ~ 09-14 | 多方言 + 备份策略 + SQLite 驱动迁移 | feature/security | PostgreSQL/SQLite 多方言（driver 抽象）、影子备份三档策略与事务化、`sqlite3` → `node:sqlite` 零工具链迁移、vitest shim 验证基础设施 | [CHANGELOG-v0.7-v0.11.md](CHANGELOG-v0.7-v0.11.md) |
| v0.12 | 2026-09-14 | 安全加固（N1–N10） | security | 修复二轮复查 10 项发现：extraParams URI 绕过、池规格指纹隔离、SQLite 每次 acquire 沙箱校验、查询超时与大 LIMIT 收口等 | [CHANGELOG-v0.12-安全加固.md](CHANGELOG-v0.12-安全加固.md) |
| v0.12.1 | 2026-09-14 | 启动修复：node:sqlite 被打包改写 | fix | tsup 把 `node:sqlite` 静态导入改写为不存在的裸名 `"sqlite"` 导致 DSH 启动失败；改用 `process.getBuiltinModule` 运行时获取，engines 升至 Node ≥22.3 | [CHANGELOG-v0.12.1-启动修复.md](CHANGELOG-v0.12.1-启动修复.md) |
| v0.13 | 2026-09-14 | 设置页「查看表」只读元数据浏览 | feature | 设置页连接卡新增「查看表 / 收起表」按钮 + 面板；新增 RPC `tables.list` / `tables.describe`，复用 `src/db/metadata.ts` 同源 driver 路径，三方言一致；不触碰数据行；新增 6 例单测；vitest 139/139、verify 59/59、tsc + tsup 全绿 | [CHANGELOG-v0.13-GUI查看表.md](CHANGELOG-v0.13-GUI查看表.md) |
| v0.13.1 | 2026-09-14 | PG 表浏览 DATABASE→SCHEMA 语义修复 | fix | PG 连接 `defaultDatabase` 是数据库名而非模式名，被直接当 `table_schema` 查询导致查不到表（MySQL 无此层级）；新增 `resolvePgSchema`：参数为当前库名或空时回落到 `public`，显式 schema 保持原样；4 例单测（vitest 143/143） | [CHANGELOG-v0.13.1-PG表浏览修复.md](CHANGELOG-v0.13.1-PG表浏览修复.md) |
| v0.14 | 2026-09-14 | 一句话加库：`db_add_connection` | feature/fix | 新增模型工具，一次调用完成「校验 + 写配置（global/workspace）+ 连通性测试」，取代读配置→手写 JSON→重载的绕行；配置写入层抽到 `config/mutate.ts`（消除潜在 import 环）；修复「新增同名静默覆盖」（不传 originalName 即 INSERT，同名报错，`replace: true` 才更新）；11 例新测（vitest 154/154） | [CHANGELOG-v0.14-一句话加库.md](CHANGELOG-v0.14-一句话加库.md) |
| v0.14.1 | 2026-09-14 | PG 查询执行文本修复 | fix | 安全网关把 `sqlify` 产物当作执行语句，而该库 `type` 参数对标识符引用无效（PG 也输出 MySQL 反引号）→ 所有可解析的 PG 查询报 `syntax error at or near "\`"`；改为「执行文本必须是调用方原文」，`sqlify` 降级为往返复核输入（新增 `normalized` 字段），`db_execute` 复核加严时只继承判定不继承文本；6 例回归（vitest 160/160） | [CHANGELOG-v0.14.1-PG查询修复.md](CHANGELOG-v0.14.1-PG查询修复.md) |
| v0.15 | 2026-10-10 | 项目视图 + 规模性能优化 | feature/perf | 设置页新增「项目」标签页（项目列表来自 usage 观察、项目私有连接可增删改、已用全局连接只读；新增 `workspaces.*` RPC + 工作区路径白名单 fail-closed）；四项优化：保存后只测新连接（O(N)→O(1)）、批量测试并发 8 + 超时上限 2s、「全部测试」最坏 335s→~50s、列表读取走 mtime 缓存、两页搜索过滤；14 例新测（vitest 174/174） | [CHANGELOG-v0.15-项目视图与性能优化.md](CHANGELOG-v0.15-项目视图与性能优化.md) |
| v0.16 | 2026-10-10 | SSH 隧道连接（FR-13） | feature/security | 连接可引用可复用 SSH 配置（agent / 私钥文件 / 内联 PEM / 密码），先连跳板机再经隧道连数据库；**主机密钥严格校验**（known_hosts 无记录即拒连，无 TOFU、无跳过开关；支持 `[host]:port` 与哈希条目、`@revoked`）；机密与数据库密码同规则（$ENV/enc:v1，页面不回显）；本地转发只绑 127.0.0.1，隧道随池条目级联关闭，SSH 配置进缓存指纹；新增「SSH 配置」标签页 + `sshProfiles.*` RPC；引入纯 JS `ssh2`（已验证无原生编译工具链）；**顺带修复既有安全缺口**：`localInfile: false` 被 mysql2 忽略（无效钉），改用有效的 `flags: ['-LOCAL_FILES']` 能力位黑名单，并把 `flags` 加入两层 denylist（该键原可重新打开 `LOCAL_FILES`/`MULTIPLE_STATEMENTS`）；真实 MySQL 穿透隧道验证通过；30 + 4 例新测（vitest 208/208） | [CHANGELOG-v0.16-SSH隧道.md](CHANGELOG-v0.16-SSH隧道.md) |
| v0.17 | 2026-10-10 | 体验修复：过期构建提示 / SSH 测试 / 结果可见 / 编辑器就近 | feature/fix | ①新增 `build.status` + 启动时对 `lib/` 做内容指纹，页面比对磁盘现状，不一致（含"旧 Host 根本不认识该接口"）即显示「请重启 DSH」横幅；②「SSH 配置」新增测试连接（`sshProfiles.test`：只做建连 + 主机密钥校验 + 认证）并显示成功/失败与建议；③修复项目卡片点「测试」无反馈（结果从未被渲染 + 异常被静默吞掉）；④编辑器改为在被编辑行正下方内联渲染（新建则落在所属项目卡片内或标签页顶部）；新增 22 例测试（vitest 230/230） | [CHANGELOG-v0.17-体验修复与SSH测试.md](CHANGELOG-v0.17-体验修复与SSH测试.md) |
| v0.18 | 2026-10-10 | 项目连接与全局共用同一张卡片 | feature/fix | 「项目」标签页的连接改由与「全局连接」相同的 `renderCard()` 渲染，获得查看表结构（表/视图清单、列、索引、DDL）与使用明细；Host 侧 `resolveSpecForRpc` 支持项目优先解析，`tables.list`/`tables.describe` 新增 `workspace`（白名单 + 审计）——**修掉"项目连接同名时静默解析到全局连接、看到另一个库的表"的正确性问题**；状态键改为「来源+项目+名称」复合键避免同名串扰；顺带为 Windows 原子写的 rename 偶发 `EPERM` 增加有限重试；新增 17 例测试（vitest 247/247） | [CHANGELOG-v0.18-项目连接共用卡片.md](CHANGELOG-v0.18-项目连接共用卡片.md) |
| v0.19 | 2026-10-10 | SSH 主机密钥类型：诊断与协商 | fix | 多密钥服务器（rsa+ecdsa+ed25519）下 ssh2 按自身偏好协商到 known_hosts **未记录的类型**，报错却说成"没有该主机的记录"（让人误以为"没登录过"）；现①三层诊断（类型不匹配 / 同类型密钥不一致 / 完全无记录，并给出 `ssh-keyscan` 命令）；②**优先协商已记录的类型**（只改顺序、校验不变），实测 `deploy@203.0.113.10:2222` 探测通过 563ms；新增 5 例测试（含多密钥服务端到端，vitest 252/252） | [CHANGELOG-v0.19-SSH主机密钥类型.md](CHANGELOG-v0.19-SSH主机密钥类型.md) |
| v0.20 | 2026-10-10 | 编辑时更改连接所属 | feature | 连接编辑器新增「所属」：可把全局连接**移入某个项目**、把项目连接**提升为全局**或换到另一个项目；新 RPC `connections.move` + 写入层 `moveConnection()`（先全量校验再落盘、先写目标后删源，最坏"重复"不"丢失"、源删除失败给明确 warning）；`passwordMode:keep` 从**源**文件解析，机密逐字节原样搬运；SSH 下拉随目标位置重算；新增 13 例测试（vitest 265/265） | [CHANGELOG-v0.20-编辑时更改所属.md](CHANGELOG-v0.20-编辑时更改所属.md) |
| v0.21 | 2026-10-17 | 复制连接 + 连接分组与折叠 | feature | 连接卡片新增「复制」：Host 端从**已存条目**复制（机密与 SSH 隧道逐字节搬运、页面全程不接触凭据），默认 `<源名>-副本` 重名递增，复制后直接打开副本编辑器改库名保存；新 RPC `connections.duplicate` + 写入层 `duplicateConnection()`（先全量校验再落盘、源文件不动、非法源拒绝复制、显式重名拒绝）；连接新增展示用 `group` 标签（1–64 字符）并透出到 `connections.list`/`db_list_connections`/`db_add_connection`；「全局连接」与每个项目的私有连接均按分组渲染**可折叠分区**（分区头=折叠按钮，无任何分组时保持原样平铺），折叠状态按来源隔离；编辑器「分组」字段带已有分组名 datalist；构建脚本支持 `export const`；新增 16 例测试（vitest 281/281） | [CHANGELOG-v0.21-复制与分组.md](CHANGELOG-v0.21-复制与分组.md) |
| — | 2026-10-19 | 记录支持的 DSH 版本（兼容矩阵 + 门禁机制） | docs | README 新增「兼容性：支持的 DSH 版本」：声明区间 `^0.1.7-rc.1 \|\| ^0.2.0-rc.1 \|\| ^0.2.1-alpha.2`，逐版本核对边界（DSH 自带 semver 7.8.5：接受 `0.1.7-rc.1`/`0.1.7`/`0.1.8`/`0.2.0-rc.1`/`0.2.0`/`0.2.1-alpha.2`/`0.2.1-rc.2`/`0.2.1`/`0.2.2`/`0.2.5`，拒绝 `0.3.0`），并写明 semver 预发布规则（`^0.2.0-rc.1` 覆盖不到 `0.2.1-rc.2`，须显式补 `^0.2.1-alpha.2`）；查明 DSH 实际门禁为 `dsh-app-boot` 的 `unmetRequirements()`（优先 `engines.dsh`，否则逐个校验 `@deepseek-ai/dsh*` 的 peer 区间，不满足即拒绝安装并回滚），`dsh.compatibility.dshReleases` 为本插件自留台账（当前 DSH 版本不读取）；`package.json` 台账补 `0.2.1-rc.2: compatible`；需求设计文档 §9 增「DSH 版本兼容」行；实测 0.2.1-rc.2 安装通过（`dsh plugin add` exit 0、`dsh --profile web --dump-config` 单行配置正确） | 本提交说明 |
| — | 2026-10-19 | 收敛 DSH 版本支持：只保留 0.2.1 线 | fix | 核查发现代码实际只支持 0.2.1 线（实机验证过的只有 `0.2.1-alpha.2` 与 `0.2.1-rc.2`；`0.1.7-rc.1`、`0.2.0-rc.1` 自 2026-10-14「0.2.x 插件契约适配」把清单改成 `dsh.bundle.patch` + `dsh.client.inject`（依赖 `dsh-client-ui-settings` 的 `settings.section` 槽位）之后再未被验证，且本机无任何 0.1.x/0.2.0 的 DSH 可测）：`dsh.engines.dsh` 与三个 `@deepseek-ai/dsh-*` peer 区间由 `^0.1.7-rc.1 \|\| ^0.2.0-rc.1 \|\| ^0.2.1-alpha.2` 收敛为 `^0.2.1-alpha.2`，`dsh.compatibility.dshReleases` 只留两个实测版本；同步修正三处 0.1.x 时代的陈旧声明（PROJECT 运行时要求、开发规范「目标宿主」、发布指南 peer 示例曾写 `dsh-tools >=0.1.2-rc.1 <0.2.0-0`）；README 兼容章节重写并给出边界核对（接受 `0.2.1-alpha.2`/`beta.1`/`rc.2`/`0.2.1`/`0.2.2`/`0.2.5`，拒绝 `0.1.7-rc.1`/`0.1.8`/`0.2.0-rc.1`/`0.2.0`/`0.2.1-alpha.1`/`0.3.0`）；收窄后以 `dsh plugin add` 重装实测门禁通过（exit 0，无兼容性拒绝） | 本提交说明 |
| — | 2026-10-29 | 补齐开源许可正文（LICENSE） | docs | 仓库此前只在 `package.json`（`"license": "MIT"`）与 README「## 许可」声明 MIT，根目录无 `LICENSE` 文件——GitHub 不显示许可徽章、法律正文缺失，上架插件市场也缺少可核对的许可文本：新增 MIT 全文 `LICENSE`（版权行 `Copyright (c) 2026 suoweiyou`），README 许可章节改为指向该文件并补一句使用说明；`package.json` 的 SPDX 字段本就是 `MIT`，无需改动；npm 发布时 LICENSE 会被自动包含（不受 `files` 白名单约束） | 本提交说明 |
| — | 2026-10-29 | README 优化：变更日志改为总述 | docs | 「文档」表删掉 4 条 `CHANGELOG-*` 逐条罗列与 `docs/records/` 行（`docs/` 实际有 15 个 CHANGELOG，原表只列到 v0.13，既长又漏），合并为一行 `docs/` 总述（按版本归档 + `records/` 内容），逐版摘要统一指向 PROJECT.md 变更日志索引；功能亮点补一条「连接管理体验（v0.18 ~ v0.21）」（项目/全局同一张卡片、编辑时改「所属」、复制连接、分组折叠、SSH 主机密钥诊断）并置于首位，使亮点覆盖到当前版本 | 本提交说明 |
| — | 2026-10-29 | 补齐第三方声明、安全边界与名称声明 | docs | 三处纯增强（不改许可协议）：① 新增 `THIRD-PARTY-NOTICES.md`——5 个运行时依赖（mysql2 / pg / zod / ssh2 为 MIT，node-sql-parser 为 Apache-2.0）的名称、许可、版权行汇总，Apache-2.0 全文 201 行原样转引（读 `node_modules/node-sql-parser/LICENSE` 由脚本嵌入，避免手抄误差），并说明本包不打包第三方代码（`lib/` 仅本项目产物，依赖由使用方 `npm install` 获得）；`package.json#files` 增列该文件，否则不会随 npm 包分发；② README 新增「安全与使用边界」——密文格式（`enc:v1:<iv>:<tag>:<cipher>`，AES-256-GCM）与密钥位置（`$DSH_HOME/db-manager/secret.key`，0600）、「能读到密钥即可解密」的边界说明、无遥测（Host 只连配置的库与跳板机，浏览器只请求同源 `/db-manager/api/*`）、能力边界（只读默认 / AST 网关 / 影子备份 / 路径白名单 fail-closed）、危险操作提醒；③ README「许可」补「名称与标识」声明（允许 fork，禁止用本名或其标识暗示官方关联/赞助/背书）与第三方声明入口 | 本提交说明 |
| — | 2026-10-29 | 新增 AI 协作入口 AGENTS.md | docs | 仓库此前无任何 AI 助手约定文件；新增根目录 `AGENTS.md`（§1 动手前必读 `docs/开发规范.md` 并按任务补读 / §2 项目一句话 / §3 硬约束速查并标注规范章节 / §4 沙箱可用命令与 `npm run build` / `npm test` 静默失败警告 / §5 改动收尾强制项 / §6 不要做 / §7 交付自检），首屏声明与规范冲突时以规范为准；已实测 DSH 将该文件识别为工作区指令注入会话；PROJECT 文档地图加一行 | 本提交说明 |
| — | 2026-10-29 | 版本标签发布规范 + README 使用方法 | docs | ① 开发规范 §7 拆为 7.1 分支与提交 / **7.2 版本标签与 Release（强制）** / 7.3 发布到市场：DSH 兼容性变化（新增或收窄 `dsh.engines.dsh`、或在新 DSH 上实测）必须 bump version → 打与 `package.json#version` 严格一致的 `v<version>` tag → 建 Release，正文写明声明区间 + 实测版本 + 两种安装命令 + CHANGELOG 链接 + 升级影响；只给实测通过的版本打 stable tag，已发布 tag 不得移动或重写；预发布用带后缀版本号 + pre-release；② 发布指南把「打 tag → 建 Release」插入发版流程与自查清单；③ README「快速开始」升级为「使用方法」：方式一源码构建安装（`npm install` → `npm run build`（沙箱用 `build-sandbox.mjs`）→ `dsh plugin --profile web add .`，并说明 DSH 只装不构建、需确认 `cordis.patch.yml` insert 块、装完重启）、方式二按 DSH 版本选插件版本（0.2.1 线可用 / 0.1.x 不支持；`add pkg@<version>` 或 `git checkout v<version>`）、方式三市场一键安装、首次配置四步、更新与卸载命令；④ AGENTS.md §3 增 tag/Release 速查 | 本提交说明 |
| — | 2026-10-10 | 文档脱敏（隐私信息清理） | docs | 清除 `docs/` 中全部真实标识：公网跳板机 IP ×14、SSH 账号 ×4、客户名 ×1、真实项目名 ×1、本机绝对路径 ×3、gitee 账号 ×2；示例地址统一为 **RFC 5737 文档专用网段**（`203.0.113.0/24`、`198.51.100.0/24`）并加注说明，账号改用 `deploy`/`app` 等通用值；保留语义必需的 `127.0.0.1`（隧道绑定）与 `0.0.0.0`（通配绑定）；全仓库（排除 node_modules/.git/lib/.build）终检 0 命中 | 本提交说明 |
| — | 2026-09-14 | 文档体系重组 | docs | 全部文档收拢至 `docs/`：新增 需求设计文档 / 开发规范 / PROJECT / CHANGELOG-v0.1-v0.6；README 精简为介绍；design/ 记录迁入 docs/records/ | 本提交说明 |
