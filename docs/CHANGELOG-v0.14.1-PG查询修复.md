# dsh-db-manager 变更记录 v0.14.1（PG 查询执行文本修复）

**变更日期**: 2026-09-14
**前置版本**: v0.14
**本文定位**: 修复 PostgreSQL 连接上 `db_query` 全量失败——安全网关把解析器重新序列化（sqlify）的产物当作执行语句，而 sqlify 忽略方言参数、输出 MySQL 反引号，PG 直接拒绝。上一区间见 [CHANGELOG-v0.14-一句话加库.md](./CHANGELOG-v0.14-一句话加库.md)。

## 一句话总览

| 项 | 类型 | 主题 | 用户感知 |
|----|------|------|---------|
| 修复 | fix | 执行文本必须是调用方原文 | PostgreSQL 连接的 `db_query` 恢复正常：普通可解析查询不再报 `syntax error at or near "\`"` |
| 加固 | refactor | sqlify 仅用于往返复核 | 复核逻辑保留（开发规范 §4.2 / 审计 N10），但不再替换执行文本与确认令牌绑定文本 |
| 测试 | test | 6 例回归 | 锁住「statement = 原文、normalized 仅作复核输入」的契约（含 PG/MySQL/fallback/多语句） |

## 问题与根因

### 现象

- MySQL 连接：`select 1 as one` → ✅
- PostgreSQL 连接：`select 1 as one` → ❌ `syntax error at or near "\`"`
- 凡含 PG 专有语法（如 `count(*)::text`）的语句反而成功

### 根因

`src/safety/classify.ts` 用 `parser.sqlify(node, { type: dialect })` 的产物**替换**了 `StatementClass.statement`，而该字段被 `src/tools/data.ts` 直接执行：

```
classify.ts:  statement = parser.sqlify(node, { type: 'postgresql' })   ← 实际输出 MySQL 反引号
data.ts:      effective = reStmt（复核产物）→ text = effective.statement ← 执行的是反引号文本
```

node-sql-parser 的 `type` 参数对**标识符引用风格**无效：传 `postgresql` 仍产出 `` SELECT 1 AS `one` ``。PostgreSQL 不接受反引号 → 语法错误。

这同时解释了两个"诡异"现象：

1. **含 PG 专有语法的语句反而正常**：`::text` 让 `astify` 抛错 → 走 regex fallback → `statement` 是原文 → 反而能执行；
2. **失败信息是数据库语法错误而非插件拒绝**：PG 方言下的解析器容忍自己生成的反引号，于是 `data.ts` 的往返复核"通过"了（类别仍为 read），一路把反引号文本送到 PostgreSQL。

### 受影响范围

所有 `dialect: postgresql` 连接的**读通道**（`db_query`）；写通道（`db_execute`）在同类路径下同样会把 sqlify 产物作为执行文本与 `confirmToken` 绑定文本（`stmtVerified = reStmt`），且 `db_query` 的 `COUNT(*)` 估算也拼接该文本。

## 修复方案

**核心原则（新增到开发规范 §4.2）**：执行文本必须是调用方原文；解析器重新序列化的产物只能用于往返复核。

1. `src/safety/classify.ts`
   - `StatementClass.statement` = **调用方原文**（单语句取 trimmed 输入；多语句按 `scanStatements` 切分的对应片段，不再整批共用）；
   - 新增 `StatementClass.normalized?: string`（sqlify 产物，注释明确"仅作复核输入，绝不执行"）。
2. `src/tools/data.ts`（`db_query`）
   - 往返复核对象改为 `stmt.normalized ?? stmt.statement`；
   - **不再** `effective = reStmt`——执行文本固定为 `stmt.statement`（原文）；
   - `COUNT(*)` 估算优先用 `normalized`（无注释干扰，best-effort 失败即跳过）。
3. `src/tools/data.ts`（`db_execute`）
   - 复核对象同样改为 `normalized`；
   - 复核"新增危险"时**只继承判定**：`stmtVerified = { ...stmt, dangerous: true, reason }`——执行与 `confirmToken` 绑定的仍是原文（也让令牌绑定文本与用户看到的语句一致）。

安全性未削弱：类别判定（read/write/ddl/unknown）、`blocked`（USE/SET/INTO OUTFILE/EXPLAIN 内层）、`dangerous`（无 WHERE 的 UPDATE/DELETE、DDL）全部基于 **AST 节点与 strings-stripped 文本**，与 sqlify 产物无关；复核机制本身保留。

## 测试

`tests/safety.spec.ts` 新增 `statement text vs parser regeneration (PostgreSQL query regression)`（6 例）：

- PG 普通可解析 SELECT → `statement` 为原文且不含反引号
- PG information_schema 风格查询 → `statement` 与输入逐字一致
- MySQL 同查询 → 同样执行原文（跨方言行为统一）
- PG 专有语法（`::text`）走 fallback → `statement` 为原文
- `normalized` 与 `statement` 分离（若方言可重新序列化则两者不同）
- 多语句批次 → 每条 `statement` 为其对应原文片段（非整批）

全套 160/160（原 154 + 6）。

## 文件变更清单

| 类型 | 路径 | 说明 |
|------|------|------|
| 代码 | `src/safety/classify.ts` | `statement` 改回原文（含多语句逐条切分）；新增 `normalized`（仅复核用） |
| 代码 | `src/tools/data.ts` | `db_query` / `db_execute` 复核对象改为 `normalized`；执行与令牌绑定文本固定为原文；COUNT 估算改用 `normalized` |
| 测试 | `tests/safety.spec.ts` | 新增 6 例 PG 回归 |
| 文档 | `docs/开发规范.md` | §4.2 新增红线「执行文本必须是调用方原文」及其理由 |
| 文档 | `docs/PROJECT.md` | 变更日志索引追加 v0.14.1 |
| 文档 | `docs/CHANGELOG-v0.14.1-PG查询修复.md` | 本文件 |

## 运行验证

| 验证层 | 结果 |
|--------|------|
| `tsc --noEmit` | ✅ |
| vitest 全套 | ✅ 160/160（14 spec） |
| 沙箱构建 | ✅ host + client（含三道门禁） |

## 已知边界

1. **PG 的 `COUNT(*)` 总数估算可能缺失**：估算语句内联 `normalized`（PG 下不可执行），失败即跳过——仅影响截断时的"总数估计"提示，不影响查询本身与数据返回。
2. **多语句分片保留尾分号**（`scanStatements` 既有行为）：两条通道都只接受单条语句，该路径仅用于分类信息完整性。
3. **本例未新增集成测试**：PG 真库集成仍以 `PGSQL_TEST_URL` 门控（本机未配置）；回归由 classify 层契约用例覆盖（根因即为该层）。
