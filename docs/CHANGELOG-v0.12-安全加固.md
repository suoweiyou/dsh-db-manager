# dsh-db-manager 变更记录 v0.12

**变更日期**: 2026-09-14
**前置版本**: v0.11（SQLite 驱动迁移 `node:sqlite`）
**本文定位**: 安全加固轮——修复二轮安全审计（《安全审计-复查-新增发现》）确认的 N1–N10 共 10 项发现。上一区间变更见 [CHANGELOG-v0.7-v0.11](./CHANGELOG-v0.7-v0.11.md)。

---

## 一句话总览

| 项 | 严重度 | 主题 | 用户感知 |
|---|---|---|---|
| N1 | 中·偏高 | extraParams 白名单补 `uri`/`connectionString`（mysql2 URI 合并绕过） | 恶意/误填 `extraParams.uri` 的连接配置被直接拒绝 |
| N2 | 中 | 连接池缓存按连接规格指纹隔离 | **改连接配置立即生效**：编辑 host/密码后工具连新库，不再残留旧池 |
| N3 | 中 | SQLite 沙箱每次 acquire 重校验 + realpath | 跨工作区不能借缓存绕过路径白名单；junction/symlink 逃逸被封死 |
| N4 | 中 | MySQL 查询超时默认下发 + 自带大 LIMIT 外层收口 | `db_query` 不再因漏写 LIMIT/超大 LIMIT 卡死或打爆内存 |
| N5 | 低 | 池缓存键重构，消除 `::` 碰撞与前缀误归因 | 连接名含 `::` 不再互相污染/误关池 |
| N6 | 低 | `bin/encrypt.js --key` 拒绝覆盖已存在的非 32 字节文件 | 传错 `--key` 路径不再毁文件 |
| N7 | 低 | GUI RPC 令牌改常量时间比较 | 与确认令牌同一安全标准 |
| N8 | 低 | 审计目录/文件权限收紧（0700/0600 best-effort） | 非 Windows 上审计文件仅属主可读 |
| N9 | 低 | `useGlobal` 白名单生效（FR-2 补实现） | 工作区可用 `useGlobal` 收敛可见的全局连接 |
| N10 | 低 | db_query/db_execute 规范化文本复核（sqlify 往返一致性） | 解析器规范化改写语义的语句被拒绝而非照原样执行 |

**验证**: typecheck ✓；vitest shim runner **133/133**（原 118 + 新增 15）；`scripts/verify.mjs` **59/59**。

---

## 1. N1 — extraParams `uri` 绕过（本轮最重要的修复）

### 1.1 根因

mysql2 `ConnectionConfig` 构造时若发现 `options.uri`，会把 URI query string **逐 key 合并**进配置（仅跳过已被显式设置为 truthy 的 key）。此前 M6 的 denylist 只检查 extraParams 的字面 key，`uri` 值内部携带的 `multipleStatements=true&localInfile=true&ssl={"rejectUnauthorized":false}` 可直接在驱动层生效——且预置 `multipleStatements: false` 也防不住（falsy 视为"未设置"，仍被 URI 值覆盖）。

### 1.2 修复（三层）

1. **schema 拒绝**（`src/config/schema.ts`）：`FORBIDDEN_EXTRA_PARAMS` 补 `uri`、`connectionstring`（refine 已按小写比较，大小写变体同锁）。
2. **驱动剥离**（`src/db/mysql-driver.ts` / `src/db/pgsql-driver.ts`）：spread 后防御性 `delete uri/connectionString`，即使绕过 schema 也进不了驱动；pg 侧 denylist 同步补 `uri`。
3. **选项钉死**（`src/db/mysql-driver.ts`）：`multipleStatements: false`、`localInfile: false` 在 spread 之后硬性设置——单语句安全网关依赖的驱动开关不再依赖 denylist 单层。

### 1.3 测试

- `tests/config.spec.ts`：`{uri|URI|connectionString|ConnectionString}` 四形态 extraParams 全部拒绝。
- `tests/hardening.spec.ts`：`buildMysqlPoolOptions` 断言 uri/connectionString 已剥离、双开关为 false、host/TLS 不受 spread 影响。

---

## 2. N2 + N5 — 连接池缓存重构

### 2.1 问题

- 缓存键 `name::dialect::db` 不含连接规格：编辑连接（改 host/密码/file）后旧池继续使用，`db_reload_config` 也不清理 → "GUI 测试新配置通过，工具却仍打旧库"。
- `::` 拼接使连接名含 `::` 时跨连接共享驱动（错凭据）；`close()` 的 `startsWith(name::)` 前缀匹配会误关别的连接。

### 2.2 修复（`src/db/pool.ts`）

- 两级缓存：`Map<连接名, Map<内层键, DatabaseDriver>>`——close/retainOnly 按连接名**精确**操作，无前缀归因。
- 内层键 = JSON `{dialect, target, fingerprint}`；`target` 服务方言为生效 database，**SQLite 为 realpath 解析后的文件路径**。
- `fingerprint` = host/port/username/password/file/ssl/extraParams 的 sha256 前 12 位：**编辑连接 → 新驱动 + 旧驱动自动关闭**，陈旧池问题在 acquire 层自愈。

---

## 3. N3 — SQLite 沙箱：校验从"只在建池时"改为"每次 acquire"

- `PoolManager.acquire` 对 sqlite **每次**重跑 `validateSqliteFilePath`（fail-closed）：跨工作区缓存命中不能再绕过各自的 allowedRoots。
- 缓存键使用 realpath 解析后的文件路径：两个工作区即使相对路径字符串相同也不会共享句柄；连接内其它 sqlite 旧目标条目自动清理。
- `validateSqliteFilePath` 用 `fs.realpathSync` 解析文件（不存在时回退最近存在祖先目录）与 allowedRoots，再做包含性判断——工作区内植入 junction/symlink 指向 `C:\Windows\SAM` 之类的逃逸路径被拒绝。
- 已知行为维持：`db_test_connection`/RPC 测试路径以 `process.cwd()` 兜底（v0.9 H2 既有设计）；"工作区相对路径"在 workspace ≠ 进程 cwd 时仍被拒（fail-closed）。

---

## 4. N4 — MySQL 查询超时 + LIMIT 收口

- `MysqlDriver` 保存 `queryTimeoutMs`，query/execute/withTransaction 全部默认下发 `timeout`（v0.7 重构时丢失的行为恢复）。语义照旧：mysql2 超时是客户端不活动超时、不终止服务器端执行（audit M7），但宿主不再无限等待。
- 新增 `enforceReadLimit(statement, limit, cap)`：语句自带 LIMIT 超过请求 cap 时，包裹为 `SELECT * FROM (…) AS __dbm_l LIMIT cap`——外层 LIMIT 真正限制驱动缓冲的行数，`SELECT * FROM t LIMIT 99999999999` 不再全量拉回宿主内存。
- `db_query` 的 COUNT 估算改用复核后的规范文本（见 §6）。

---

## 5. 低危项（N6–N9）

| 项 | 修复 |
|---|---|
| N6 | `bin/encrypt.js`：仅 ENOENT 创建密钥；已存在但长度≠32 → 可读错误 + exit 1（文件原样保留）；非 ENOENT 读错误也显式退出 |
| N7 | `src/rpc/routes.ts`：`tokenMatches`（长度相等 + `timingSafeEqual`）替代 `!==` |
| N8 | `src/audit/log.ts`：审计目录 `mode 0o700` 创建、日文件首次创建后 best-effort `chmod 0600`（Windows 为 no-op，依 profile ACL） |
| N9 | `src/config/store.ts`：`useGlobal` 非空数组时按 FR-2 白名单过滤全局连接；空/缺省保持"全部可见"（向后兼容） |

---

## 6. N10 — 规范化文本复核（db_query / db_execute）

**问题**：AST 路径执行的是 sqlify 重生成文本。若 sqlify 改写语义（或 sqlify 失败回退原文），"分类对象 ≠ 执行对象"。

**修复**（`src/tools/data.ts`）：对规范化文本重新分类并要求结论在往返后一致——

- `db_query`：复核后必须仍是单条、明确只读、非 dangerous/blocked，否则拒绝；
- `db_execute`：类别翻转或危险标记消失 → 拒绝（`unverifiable`，审计状态 `refused`）；规范化**新增**危险标记 → 采纳更严结论走确认闭环；出现 blocked 形态 → 直接拒绝；
- COUNT 估算与实际执行均使用复核后的文本。

**残余（记录在案）**：SELECT 调用带写副作用的存储函数/UDF 无法静态识别，且被截断触发的 COUNT 估算会二次执行该语句——根本缓解是 DB 侧最小权限账号（PRD 既有建议）。

---

## 7. 文件变更清单

### 代码（9）
- `src/config/schema.ts` — denylist 补 `uri`/`connectionstring`
- `src/db/mysql-driver.ts` — 剥离 URI 入口 + 钉死双开关 + queryTimeoutMs 默认下发；导出 `buildMysqlPoolOptions`
- `src/db/pgsql-driver.ts` — denylist 补 `uri` + 剥离 URI 入口
- `src/db/pool.ts` — PoolManager 两级缓存重构（指纹/N2/N3/N5）+ realpath 校验
- `src/tools/data.ts` — `enforceReadLimit` + 规范化复核（N10）
- `src/config/store.ts` — `useGlobal` 白名单（N9）
- `src/audit/log.ts` — 审计权限收紧（N8）
- `src/rpc/routes.ts` — 令牌常量时间比较（N7）
- `bin/encrypt.js` — 拒绝覆盖非 32 字节密钥文件（N6）

### 测试（2，新增 15 例）
- `tests/config.spec.ts` — URI 四形态拒绝；useGlobal 生效/兼容
- `tests/hardening.spec.ts` — 池指纹复用/失效重建、close 名称隔离、retainOnly、SQLite 跨 root 拒绝、symlink 逃逸拒绝、mysql options 加固、enforceReadLimit ×4

### 文档（2）
- `design/documents/changes/dsh-db-manager/records/安全审计-复查-新增发现.md` — 全部发现标注修复状态 + 实施记录 + 残余风险
- `docs/CHANGELOG-v0.12-安全加固.md` — 本文件

---

## 8. 运行验证

```bash
# 类型检查
node node_modules/typescript/lib/tsc.js --noEmit

# vitest 全套（133 例，11 spec）
node --import ./scripts/register-vitest-shim.mjs scripts/run-vitest.mjs

# 核心逻辑验证（59 例）
node scripts/verify.mjs
```

**环境备注**: 本轮发现 `node_modules/pg`/`@types/pg` 缺失（package.json 已声明，疑似本地依赖被部分清理），已 `npm install` 补齐；`pg` 的 TS2307 编译错误与本轮代码变更无关。另：`bin/encrypt.js` 的覆盖拒绝行为已人工验证（1 字节文件被拒、内容未变；正常路径生成 `enc:v1:…`）。

---

## 9. 已知边界（记录在案，非漏洞）

1. **审计含语句字面量**：数据面字面量（如 `UPDATE … SET token='…'`）会进审计文件（≤2000 字符）——与 FR-11"语句元数据"定位一致，如需更强隐私可后续加 VALUES 检测。
2. **只读通道不承诺无副作用**：SELECT 调用带写副作用的存储函数无法静态识别；COUNT 估算会二次执行该语句。根本缓解：DB 侧最小权限账号。
3. **确认令牌非真人间隔**：宿主审批通道不可用时退回令牌闭环（v0.9 既有记录）。
4. **SQLite 测试路径 process.cwd() 兜底**：v0.9 H2 既有设计。
