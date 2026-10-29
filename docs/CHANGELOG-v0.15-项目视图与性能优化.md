# dsh-db-manager 变更记录 v0.15（项目视图 + 规模性能优化）

**变更日期**: 2026-10-10
**前置版本**: v0.14.1
**本文定位**: 设置页新增「项目」标签页（项目列表 + 项目下连接，可管理项目私有连接），并完成 4 项随连接数增长的性能优化。上一区间见 [CHANGELOG-v0.14.1-PG查询修复.md](./CHANGELOG-v0.14.1-PG查询修复.md)。

## 一句话总览

| 项 | 类型 | 主题 | 用户感知 |
|----|------|------|---------|
| 新功能 | feature | 「项目」标签页 | 设置页可查看本插件服务过的项目，展开看到项目私有连接（可增删改）与该项目使用过的全局连接 |
| 优化 A | perf | 保存后只测刚保存的连接 | 连接越多，「加一个库」越快（不再每次都全量重测） |
| 优化 B | perf | 批量测试并发 8 + 超时上限 2s | 「全部测试」从最坏 335s（200 连接）降到约 50s |
| 优化 C | perf | 列表读取走 mtime 缓存 | 每次打开/刷新不再重复读盘解析 |
| 优化 D | perf/UX | 搜索过滤 | 连接/项目变多后可直接筛选，不再靠滚动找 |
| 安全 | security | 工作区路径白名单 | 页面只能管理插件观察到的项目（fail-closed），杜绝任意路径写入 |

## 一、规模性能：实测数据与优化

### 实测（优化前的基线）

| 路径 | 连接数 11 | 50 | 200 | 1000 |
|------|----------|----|----|------|
| `connections.list`（读盘 + parse + N×zod） | 0.39 ms | 0.71 ms | 1.52 ms | 6.97 ms |
| 单次不可达探测（耗满超时） | — | — | 5009 ms（`connectTimeoutMs=5000`） | — |
| 「全部测试」最坏耗时（全部不可达，并发 3） | ~20 s | ~85 s | ~335 s | — |

**结论**：首页列表加载从来不是瓶颈（1000 条也仅 ~7 ms）；真正的线性放大点是**连接测试**，尤其是「保存一个连接后自动全量重测」——加第 N 个连接要付 N 次建连的代价。

### A：保存后只测刚保存的连接（`client/Section.ts`）

```diff
- void rpc('connections.testAll').then(…)   // N 次建连
+ void testSingle(savedName, scope === 'workspace' ? workspace : undefined)   // 1 次
```

加库成本由 O(N) 降为 O(1)。工作区连接也能单独测试：`connections.test` 新增可选 `workspace` 参数（经白名单校验后在工作区文件里查找 spec）。

### B：批量测试并发与超时上限（`rpc/routes.ts`）

```ts
const TEST_ALL_CONCURRENCY = 8        // 原 3
const TEST_ALL_TIMEOUT_CAP_MS = 2_000 // 单连接测试仍用配置值（默认 5s）
```

批量场景不该继承单连接超时：N 个不可达主机在并发 3/超时 5s 下是 `ceil(N/3)×5s`。现在最坏约 `ceil(N/8)×2s`（200 连接 ≈ 50s）。单个测试（`connections.test`、工具 `db_test_connection`）保持用户配置的 `connectTimeoutMs`，行为不变。

### C：列表读取走 mtime 缓存（`config/store.ts` + `rpc/routes.ts`）

`connections.list` 原先每次 RPC 都 `readFileSync` + `JSON.parse` + 逐条 zod；现改为复用 `ConfigStore` 的 mtime 缓存。为不丢失「列出校验失败条目」的能力，`FileLoad` 新增 `raw` 字段（缓存未校验的原始 JSON），`connectionView()` 据此继续渲染 invalid 卡片。文件变更时 mtime 变化自动失效。

### D：搜索过滤（`client/Section.ts`）

两个标签页各有一个搜索框：全局页按名称/主机/默认库/备注/方言/文件路径过滤，项目页按项目路径、项目连接名、使用过的全局连接名过滤。这也避免了当前规模下引入虚拟滚动的复杂度（真正上百条时再评估）。

## 二、「项目」标签页（新功能）

### 数据来源（按用户确认的方案）

项目列表 = **本插件观察到的项目**，不扫描磁盘：

- `UsageTracker.workspacePaths()`：持久化的 usage 工作区（`usage.json`，≤64）∪ 当前活跃会话的 cwd，按最近活动排序；
- 新增 `UsageTracker.knowsWorkspace(path)`：供写操作做白名单校验。

每个项目展示：

| 区块 | 内容 | 可操作性 |
|------|------|---------|
| 项目头 | 目录名、完整路径、`<项目>/.dsh/db-manager.json` 路径、私有连接数与已用全局连接数 | — |
| 项目私有连接 | 名称、方言徽章、endpoint、字段是否合法、状态点 | **可增 / 改 / 删 / 单测** |
| 使用过的全局连接 | 连接名、使用次数、最近使用时间（来自 usage） | 只读（usage 事实） |
| 其它 | `useGlobal` 白名单、`default` 默认连接、文件校验警告 | 只读展示 |

### 新增 RPC

| 方法 | 入参 | 说明 |
|------|------|------|
| `workspaces.list` | — | 项目列表 + 每项目私有连接（无凭据字段）+ 已用全局连接 + warnings |
| `workspaces.save` | `{ workspace, originalName?, connection }` | 写入 `<项目>/.dsh/db-manager.json`（复用 `saveConnectionInto({scope:'workspace'})`；明文密码即时加密；同名默认拒绝、`originalName` 才更新） |
| `workspaces.delete` | `{ workspace, name }` | 删除该项目的一条私有连接 |
| `connections.test`（扩展） | `{ name, workspace? }` | 指定 workspace 时测试项目私有连接 |

### 安全：工作区路径白名单（fail-closed）

`workspaces.save/delete` 与 `connections.test` 的 workspace 参数来自浏览器页面，因此必须校验：

```ts
resolveKnownWorkspace(usage, rawPath):
  空            → 拒绝（缺少工作区路径）
  usage 不可用  → 拒绝
  路径未被观察  → 拒绝（未知工作区…）
  否则          → 通过
```

没有这一层，持有页面令牌的任意代码就能写 `<任意目录>/.dsh/db-manager.json`。现在 GUI 只能管理插件已经服务过的项目。审计同样覆盖：`workspaces.save` / `workspaces.delete` 均留痕（含 workspace 路径与 action）。

## 三、测试

新增 `tests/workspaces.spec.ts`（14 例）：

- `UsageTracker`：工作区发现（最近优先）、活跃会话 cwd、重启后从 `usage.json` 恢复；
- 工作区写入：只写项目文件（不创建全局文件）、`replace` 语义保留密文、同名拒绝、删除单条不动其它、`useGlobal`/`default` 保留、无 cwd 拒绝、损坏文件拒写（M5）；
- **白名单**：已观察项目通过；任意路径（`C:/Windows/System32`）拒绝；空/缺失拒绝；usage 不可用时全拒。

全套 **174/174**（原 160 + 14）。

## 四、文件变更清单

| 类型 | 路径 | 说明 |
|------|------|------|
| 代码 | `src/config/store.ts` | `FileLoad.raw`（缓存未校验 JSON，供 invalid 卡片与零重读） |
| 代码 | `src/config/mutate.ts` | 新增 `deleteConnectionFrom(store,{scope,cwd},name)`；`deleteConnection` 改为其包装 |
| 代码 | `src/usage.ts` | 新增 `workspacePaths()` / `knowsWorkspace()` |
| 代码 | `src/rpc/routes.ts` | `workspaceViews`/`connectionView`/`resolveKnownWorkspace`/`findWorkspaceSpec`；`workspaces.list/save/delete`；`connections.test` 支持 workspace；testAll 并发 8 + 2s 上限；listViews 走缓存 |
| 代码 | `src/client/api.ts` | `WorkspaceListItem` / `WorkspacesListResponse` / `WorkspaceGlobalUsage` / `WorkspaceSaveArgs` |
| 代码 | `src/client/Section.ts` | 标签页切换、项目卡片（新增 `renderProjectCard`）、项目连接增删改、搜索过滤（D）、保存后单测（A）、编辑器 scope 与写入目标提示 |
| 测试 | `tests/workspaces.spec.ts` | 新增 14 例 |
| 脚本 | `scripts/run-vitest.mjs` | SPECS 增加 workspaces |
| 文档 | `docs/需求设计文档.md` | GUI 章节（标签页/项目视图）、RPC 协议、FR-16/FR-19 |
| 文档 | `docs/PROJECT.md` | 能力速览 + 变更日志索引 |
| 文档 | `README.md` | 功能亮点 |
| 文档 | `docs/CHANGELOG-v0.15-项目视图与性能优化.md` | 本文件 |

## 五、运行验证

| 验证层 | 结果 |
|--------|------|
| `tsc --noEmit` | ✅ |
| vitest 全套 | ✅ 174/174（15 spec） |
| `scripts/verify.mjs` | ✅ 59/59 |
| 沙箱构建（语法/注册/渲染三门禁） | ✅ `render=(12 createElement calls)` |
| `render-client.mjs` / `smoke-client.mjs` | ✅ 渲染成功、注册契约成立 |
| 部署产物哈希（client.js、rpc/routes.js、config/*、usage.js） | ✅ 与工作区一致 |

## 六、已知边界

1. **项目列表不含未使用过的项目**：插件不扫盘，只列出「服务过」的会话工作区。若某项目从未在此插件的会话中被使用，它不会出现（用户已确认采用该方案）。
2. **`workspacePaths` 上限 64**：`usage.json` 的工作区聚合有 64 条上限，超出后最久未用的项目会被淘汰（沿用既有约束）。
3. **项目 tab 不提供删除项目**：只能删除项目内的连接；项目本身由磁盘上的 `.dsh/db-manager.json` 决定。
4. **`connections.test` 的状态缓存按连接名**：同名的工作区连接与全局连接会共用 `statusCache` 的一个槽位；界面按名字显示状态，可能串味。当前不处理（记录在案），如需精确可扩展为 `workspace::name` 键。
5. **D 未做虚拟滚动**：搜索过滤 + 折叠已覆盖当前规模；连接数上千时再评估虚拟化。
