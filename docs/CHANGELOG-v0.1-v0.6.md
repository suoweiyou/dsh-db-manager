# dsh-db-manager 变更记录 v0.1 → v0.6（项目启动日）

**变更日期**: 2026-09-09（单日内完成 PRD 评审 → M2–M4 交付 → 两轮安全审计）
**前置版本**: 无（项目起点，原名 dsh-mysql-manager）
**本文定位**: 首日全链路——需求四轮迭代评审通过、M2–M4 里程碑交付、两轮安全审计与修复。后续区间见 [CHANGELOG-v0.7-v0.11](./CHANGELOG-v0.7-v0.11.md)。逐条原始留痕见 [records/迭代日志.md](./records/迭代日志.md)。

---

## 一句话总览

| 版本 | 日期 | 主题 | 说明 |
|---|---|---|---|
| v0.1 | 2026-09-09 | PRD 初稿 | 原名 dsh-mysql-manager，全量 GUI 方案 |
| v0.2 | 2026-09-09 | 更名 + 砍 GUI（用户决策） | 更名 dsh-db-manager；砍掉浏览器 GUI，仅 Host 侧「模型工具 + 配置文件」 |
| v0.3 | 2026-09-09 | PRD 首评 → 修复 → 通过 | 评审判定：有条件通过（2 项 minor：P1/P2 场景缺失、OpenSpec 回链缺失）；修复后复核通过 |
| v0.4 | 2026-09-09 | 撤回砍 GUI（用户决策） | 恢复连接管理 GUI（FR-16：查看连接与状态、增删改/测试/默认连接）；数据面仍由模型工具承担；里程碑重排（GUI 并入 M2）；增量评审通过 |
| v0.5 | 2026-09-09 | 影子备份 + 专项安全审计 | FR-9 增强：UPDATE/DELETE 前自动影子备份受影响行；同日完成专项安全审计并修复 7 项（55/55） |
| v0.6 | 2026-09-09 | 使用关联 + M4 加固 + 代码安全审计 | FR-17 会话/工作区使用关联；审计日志落地；代码安全审计高危 2 + 中危 7 全部修复（81→92/92） |

---

## 1. PRD 演进与评审（v0.1 – v0.4）

- **v0.1 → v0.2**：用户决策更名 `dsh-db-manager`；砍掉全部浏览器 GUI，仅保留 Host 侧插件。
- **首次评审（v0.2）**：基于 prd-review 技能 9 项自检清单，判定 △ 有条件通过——2 项 minor：#5b2 P1/P2 功能场景缺失（补场景-FR 覆盖映射与补场景义务）、#8 OpenSpec 回链约束缺失（补 §5.9 衔接约束）。
- **v0.3**：修复 2 项 minor 后复核，**✓ 通过**。
- **v0.4**：用户撤回"砍掉 GUI"——恢复浏览器端连接管理 GUI，范围限定为连接管理（查看连接的数据库与连接状态、增删改/测试/默认连接）；库表浏览与 SQL 控制台仍由模型工具承担。增量复审 7 项受影响自检项全部通过，**✓ 通过**。
- 评审纪要：[records/PRD-dsh-db-manager-评审纪要.md](./records/PRD-dsh-db-manager-评审纪要.md)。

## 2. 里程碑交付（M2 / M3 / M4）

### M2 插件骨架 + 连接管理

- 双端 Cordis 插件包工程（Host ESM + Client ModuleLoader 模块）、composition 挂载示例。
- 配置存储/校验/加密：全局 `~/.dsh/db-manager/connections.json` + 工作区 `.dsh/db-manager.json`；zod strict 校验；密码 `$ENV:VAR` / AES-256-GCM 双形态，明文拒绝；`bin/encrypt.js` 离线生成密文。
- mysql2 连接池 + PoolManager；RPC 路由 `/db-manager/api/*` + 进程内随机令牌（`x-dbm-token`）。
- 连接管理 GUI（设置页「数据库」分区：卡片/状态点/增删改/测试）；基础工具 `db_list_connections` / `db_test_connection` / `db_reload_config`。

### M3 元数据与查询 + 安全网关

- 工具：`db_list_databases` / `db_list_tables` / `db_describe_table` / `db_query` / `db_execute`。
- SafetyGateway：node-sql-parser AST 分类 + 规则层（多语句拆分、WHERE 缺失、LIMIT 注入、标识符转义白名单）；只读模式下写语句 100% 拒绝。
- 高危确认闭环：拒绝 + HMAC 确认令牌（绑定连接名+语句哈希+过期，一次性）+ 用户确认后重试。

### M4 加固

- 审计日志：`~/.dsh/db-manager/audit/` 按天 JSONL、30 天滚动清理、凭据打码、`auditEnabled` 开关；db_query/db_execute 富条目（sql/kind/confirmed/refused-dangerous），其余工具经 wrapper 留痕，RPC connections.save/delete 留痕。
- `db_reload_config` 对已消失连接关闭连接池（retainOnly）。
- 集成测试 `tests/integration/mysql.spec.ts`（`DBM_TEST_URL` 门控，套件自建/自毁临时库）。

## 3. 专项安全审计（records/安全审计-2026-09-09.md）

逐文件人工审查（注入面、鉴权面、密钥处理、确认闭环、渲染安全），**修复 7 项**：

| 严重度 | 问题 | 修复 |
|--------|------|------|
| 高 | `SELECT … INTO OUTFILE/DUMPFILE/@var` 可经只读通道在服务器上写文件/改会话变量 | INTO 检测 → `blocked` |
| 高 | `USE db` / `SET …` 永久改变共享池连接的会话状态 | use/set 语句类型 → `blocked`（charset 引导写进 extraParams） |
| 中 | LIMIT 注入可被行尾注释吞掉（查询变为无上限） | `injectReadLimit()`：规则层产物包裹派生表 `SELECT * FROM (…) AS __dbm_l LIMIT n` |
| 中 | 确认令牌 5 分钟内可重复使用 | 已用令牌台账（Set，>512 清理过期），重放拒绝 |
| 中 | 密钥文件损坏时静默重建新密钥（既有密文全部失效且无提示） | 抛 `SecretError`，文件保持原样 |
| 中 | `SHOW CREATE TABLE` 标识符仅反引号翻倍、未限字符集 | `quoteIdentifier` 按 `/^[\p{L}\p{N}_$]+$/u` 白名单校验 |
| 低 | GUI RPC fetch 无超时 | `AbortSignal.timeout(30_000)` |

同时确认了一批已安全的设计点（information_schema 参数化、多语句/会话语句拦截、HMAC 令牌防伪造、RPC 令牌门控、原子写配置、React 自动转义等）。验证基线 **55/55**。

## 4. 代码安全审计（records/代码安全审计报告.md）

全量通读源码 + node-sql-parser 边界实证，发现**高危 2 / 中危 7 / 低危 11**；高危与中危全部修复：

- **H1 EXPLAIN 绕过**（高危）：`EXPLAIN ANALYZE <写语句>` 可经只读通道原样执行（MariaDB 实际执行内层写语句）。修复：AST 层 explain 内层守卫 `explainInnerIsRead` + 兜底正则层剥离 EXPLAIN/ANALYZE/FORMAT 修饰符分类内层语句；`EXPLAIN ANALYZE <写/DDL>` 直接 blocked。
- **H2 确认闭环人工化**（高危）：接入宿主 `ApprovalService`——用户拒绝/取消时不签发令牌、审批失败不执行；服务不可用才退回 PRD FR-9 令牌闭环；审计新增 `approval` 字段（host-approval/confirm-token）。
- **M1** INSERT/REPLACE 不再误判高危（WHERE 缺失规则收窄到 UPDATE/DELETE）；**M2** parsePasswordSecret 报错不回显值片段；**M3** sanitizeSql 打码 IDENTIFIED BY/PASSWORD()/SET PASSWORD 内嵌口令；**M4** 工作区同名覆盖全局时显著警告；**M5** 全局配置读取/解析失败时 GUI 保存/删除拒绝变更（防静默清空）；**M6** extraParams 双重加固（身份/池策略/TLS 后置展开 + schema 拒绝危险键）；**M7** 客户端 inactivity 假超时如实化（明示服务器端可能仍在执行）。
- 低危 11 项（L1–L11）记录跟踪，详见报告 §四。

验证基线：高危修复后 **81/81**，中危全修后 **92/92**（`tsc`/`tsup` 同步通过）。

## 5. 验证基线演进

| 时点 | 单测基线 |
|------|---------|
| 专项审计修复后 | 55/55 |
| 代码审计高危修复后 | 81/81 |
| 中危 7 项修复后 | 92/92 |

> v0.6 之后的多方言、备份策略、驱动迁移与第三轮审计，见 [CHANGELOG-v0.7-v0.11.md](./CHANGELOG-v0.7-v0.11.md) 与 [CHANGELOG-v0.12-安全加固.md](./CHANGELOG-v0.12-安全加固.md)。
