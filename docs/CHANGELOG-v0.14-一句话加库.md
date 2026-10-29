# dsh-db-manager 变更记录 v0.14（一句话加库：db_add_connection）

**变更日期**: 2026-09-14
**前置版本**: v0.13.1
**本文定位**: 新增模型工具 `db_add_connection`——一次调用完成「校验 + 写配置 + 连通性测试」，取代原先「读配置 → 手写 JSON → 重载」的多轮绕行；并修正配置写入层的「新增同名静默覆盖」缺陷。上一区间见 [CHANGELOG-v0.13.1-PG表浏览修复.md](./CHANGELOG-v0.13.1-PG表浏览修复.md)。

## 一句话总览

| 项 | 类型 | 主题 | 用户感知 |
|----|------|------|---------|
| 新功能 | feature | `db_add_connection` 模型工具 | 对话里直接给参数即可注册 MySQL / PostgreSQL / SQLite 连接，一次调用完成写入与连通性验证 |
| 重构 | refactor | 配置写入逻辑抽到 `src/config/mutate.ts` | 无用户可见变化；消除 `tools → rpc → tools` 潜在 import 环，GUI 与工具共用同一套写入逻辑 |
| 修复 | fix | 「新增同名」不再静默覆盖 | 不传 `originalName` 时同名一律报「已存在同名连接」，`replace: true` 才更新（此前冲突检查永不触发） |
| 测试 | test | `tests/add-connection.spec.ts` 11 例 | 覆盖落盘密文、同名拒绝/替换、workspace scope、sqlite、字段校验、连通性测试、审计留痕 |

## 背景与动机

用户反馈：通过对话让 DSH 添加数据库时，模型每轮都要先读配置文件、再手写 JSON、再调用重载——"每次都查询配置等一堆查询思考"。

排查确认：**能力本就存在**——`rpc/routes.ts` 的 `saveConnection()` 已实现完整逻辑（密码策略、zod 校验、原子写、缓存失效、损坏文件拒写）。缺的只是**模型侧暴露面**：它此前仅由 GUI 的 RPC 调用。因此本次不新写写入逻辑，而是（1）把写入逻辑抽到中性模块，（2）以模型工具形式暴露，并（3）顺带把「写入 + 验证」合并为一次调用。

## 实现

### 1. 配置写入层抽取：`src/config/mutate.ts`（新）

从 `rpc/routes.ts` 迁出并泛化：

- `readConfigFile(filePath, label)` / `connectionsOf(raw)` / `writeConfigFile(store, filePath, doc)`（原子写：tmp + rename；写后 `store.invalidate()`）
- `connectionFilePath(store, scope, cwd)`——`global` → `store.globalPath`；`workspace` → `workspaceConfigPath(cwd)`
- `saveConnectionInto(store, { scope, cwd }, body)`——完整保存流程，返回 `{ ok, name, path, action: 'created'|'replaced', spec, warnings? }`
- `saveConnection(store, body)` / `deleteConnection(store, name)`——global 便捷包装，保持既有签名

保留的行为契约：损坏/不可解析的文件**拒绝写入**（审计 M5）；明文入参**即时加密**且不落盘明文；写入保留文件其它顶层字段（workspace 文件的 `useGlobal` / `default` 不再被丢弃）。

`rpc/routes.ts` 改为复用该模块（GUI 行为不变，仍只写全局文件）。

### 2. 模型工具 `db_add_connection`（`src/tools/index.ts`）

参数：`name` / `dialect` / `scope` / `host` / `port` / `username` / `password` / `defaultDatabase` / `file` / `mode` / `comment` / `replace` / `test`。

行为：

1. 组装与 GUI 相同的 `connection` body（`passwordMode: 'plain'` 走即时加密；未传密码则 `'keep'` 保留既有密文；sqlite 用 `'none'`）；
2. `saveConnectionInto(...)` 写入（`scope` 默认 `global`；`workspace` 需会话 cwd）；
3. 默认立即 `testConnection()` 并回报延迟或分类错误（`test: false` 关闭）；
4. 自写审计条目（`action: 'db_add_connection'`，含 scope/action/dialect/test 结果；已加入 `selfAudited` 集合避免重复包装）。

### 3. 修复：新增同名的静默覆盖

原实现：

```ts
const targetIndex = connections.findIndex((e) => e['name'] === (originalName ?? spec.name))
const conflicts = connections.some((e, i) => e['name'] === spec.name && i !== targetIndex)
```

不传 `originalName` 时 `targetIndex` 命中的就是同名条目，于是 `conflicts` 恒为 false——**"新增"实际是 upsert，冲突检查永不触发**。现改为：

```ts
const targetIndex = originalName !== undefined ? connections.findIndex((e) => e['name'] === originalName) : -1
```

语义变为：不带 `originalName` 即 INSERT，同名报错；`replace: true`（工具）或 GUI 编辑（带 `originalName`）才更新。GUI 新建同名连接现在会得到明确错误而非静默覆盖（更安全，也不影响正常编辑流程）。

## 测试

`tests/add-connection.spec.ts`（11 例）：明文密码仅以 `enc:v1:` 落盘（文件与返回值均无明文）｜同名拒绝 + `replace` 更新且保留密文｜`scope: workspace` 写工作区文件且全局文件不被创建｜sqlite 分支（file 且无 password）｜缺 host / username / 新连接缺密码的可读报错｜非法字段被 schema 拒绝且不落盘｜默认执行连通性测试并回报分类失败（`127.0.0.1:1`）｜成功与拒绝各留审计条目且不含密码｜workspace 文件保留 `useGlobal` / `default`｜无 cwd 时拒绝 workspace 写入｜损坏文件拒写。

全套 154/154（原 143 + 11）。

## 文件变更清单

| 类型 | 路径 | 说明 |
|------|------|------|
| 新增 | `src/config/mutate.ts` | 配置写入层（scope 感知、M5 拒写、密文落盘） |
| 代码 | `src/rpc/routes.ts` | 改为复用 `config/mutate.ts`；移除重复实现 |
| 代码 | `src/tools/index.ts` | 新增 `db_add_connection` 工具 + 审计自留痕 |
| 测试 | `tests/add-connection.spec.ts` | 新增 11 例 |
| 测试 | `tests/rpc-mutation.spec.ts` | 导入源改为 `config/mutate.js` |
| 脚本 | `scripts/run-vitest.mjs` | SPECS 增加 add-connection |
| 文档 | `docs/需求设计文档.md` | §5.3 工具协议表新增 `db_add_connection` |
| 文档 | `docs/PROJECT.md` | 工具计数 8→9、能力速览新增「连接注册」行、变更日志索引 |
| 文档 | `README.md` | 功能亮点新增「一句话加库」；安全基线表述对齐工具入参 |
| 文档 | `docs/CHANGELOG-v0.14-一句话加库.md` | 本文件 |

## 运行验证

| 验证层 | 结果 |
|--------|------|
| `tsc --noEmit` | ✅ |
| vitest 全套 | ✅ 154/154（14 spec） |
| 沙箱构建 | ✅ host + client（含三道门禁） |
| 部署产物核验 | ✅ 与工作区哈希一致 |

## 设计取舍与已知边界

1. **密码仅支持明文入参**（用户明确选择）：明文会出现在对话上下文中，落盘为密文。配置文件中手写 `$ENV:VAR` 的能力不变；模型若被要求"不要看到密码"，仍可由用户手工编辑配置文件。
2. **不提供删除工具**：本次范围仅"添加/更新"；删除仍走 GUI 或手工编辑（对称能力可后续按需补）。
3. **workspace scope 依赖会话 cwd**：无 cwd 时明确拒绝（不猜测路径）。
4. **写配置属敏感操作但未接入人工审批**：与 GUI 保存同级（本机 DSH 页面/会话内操作），已有审计留痕；数据面写执行（`db_execute`）的高危确认闭环不受影响。
5. **`replace: true` 的更新范围**：仅替换同名条目，其它连接与文件顶层字段保持不变。
