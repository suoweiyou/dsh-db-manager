# dsh-db-manager 变更记录 v0.20（编辑时更改连接所属）

**变更日期**: 2026-10-10
**前置版本**: v0.19
**本文定位**: 连接编辑器新增「所属」选择器 —— 编辑全局连接时可把它**移入某个项目**，编辑项目连接时可**提升为全局**（或换到另一个项目）。上一区间见 [CHANGELOG-v0.19-SSH主机密钥类型.md](./CHANGELOG-v0.19-SSH主机密钥类型.md)。

## 一句话总览

| 项 | 类型 | 说明 |
|----|------|------|
| 「所属」选择器 | feature | 编辑器顶部可选择目标：`全局（所有项目共享）` 或任一已观测项目；选择后即显示写入目标与"将更改所属"提示 |
| 跨文件搬迁 | feature | 新 RPC `connections.move` + 写入层 `moveConnection()`：从源配置文件移除、写入目标配置文件，**机密原样保留** |
| 失败安全 | design | 两个文件在写入前**全部读取并校验完毕**；先写目标、后删源，最坏情况是"两处都有"（可恢复），**绝不会丢**；源删除失败时明确告知 |
| 新增连接同样可选所属 | feature | "+ 添加"沿用上下文默认值，但下拉可改，创建时直接用目标位置 |

## 一、交互

编辑器顶部新增一行：

```
所属  [ 全局（所有项目共享） ▾ ]   ← 或 项目：my-app / 项目：orders-portal …
      保存后会把该连接从原位置移出并写入新位置（密码等机密原样保留）。

写入目标：D:/proj/my-app/.dsh/db-manager.json（仅该项目可见）；
原位置：~/.dsh/db-manager/connections.json
```

- 标题会出现「（将更改所属）」标记；
- 若尚未有可选项目，提示「当前没有可选的观测项目（在本插件的某个会话里调用过 db_* 工具的项目才会出现）」，不会给出一个点不动的空下拉；
- **SSH 跳板机下拉随目标位置变化**：项目 A 私有声明过的 SSH 配置在项目 B 里不可用，因此选项按目标位置重新计算（全局配置在任何位置都可见）。

## 二、Host 侧

### 2.1 写入层重构

把「连接体校验 + 密码策略」从 `saveConnectionInto` 抽成 `prepareConnection(input, existingPassword)`，两处复用。关键差异在 `existingPassword` 的来源：

| 场景 | `passwordMode: 'keep'` 解析自 |
|------|------------------------------|
| 普通保存 | **目标文件**里同名条目 |
| 搬迁 | **源文件**里的条目 ← 否则搬迁时"保留密码"必然失败 |

因此搬迁全程**不接触明文**：密文（`enc:v1:…` 或 `$ENV:VAR`）原样搬运，既不在此处解密也不重新加密。

### 2.2 `moveConnection(store, from, to, body)`

```
from = { scope: 'global' }            或 { scope: 'workspace', cwd }
to   = { scope: 'global' }            或 { scope: 'workspace', cwd }
body = { originalName, connection: { …, passwordMode: 'keep' } }   // 与保存同形
```

流程（**先校验、后落盘**）：

1. 解析两个文件路径；若相同 → 退化为普通更新（`action: 'updated'`）；
2. 读取两个文件（任一损坏即拒写 —— 沿用 M5 保证）；
3. 在**源**文件里定位 `originalName`，不存在则报"在源位置不存在"；
4. 用源条目的机密执行 `prepareConnection`，校验失败 → 两个文件都不动；
5. 检查**目标**文件是否已有同名连接 → 冲突则拒绝，两个文件都不动；
6. 写目标文件（插入）；
7. 删源文件里的条目；若这一步失败，返回 `ok: true` + `warning`：**连接已在目标位置，但源位置可能仍有残留**，请人工确认。

第 6/7 的先后顺序是刻意的：中途失败只会产生"重复"，不会产生"丢失"。

### 2.3 RPC `connections.move`

| 入参 | 说明 |
|------|------|
| `originalName` | 必填：当前所属位置里的连接名（编辑器里改名时仍是旧名） |
| `fromWorkspace` | 省略 = 全局；否则为项目路径 |
| `toWorkspace` | 省略 = 全局；否则为项目路径 |
| `connection` | 与 `connections.save` / `workspaces.save` **同形**（含 `passwordMode`） |

- 两端的项目路径都过 **fail-closed 路径白名单**（只能操作插件已观察到的项目），非法路径 422；
- 响应 `{ ok, name, action, warning? }`；审计记录 `connections.move`，detail 带 `from=/to=/action=`（失败时记错误原因）；
- `warning`（源残留）走 `sanitize()` 后才回给页面。

## 三、Client 侧

- `EditorState` 拆成**源**（`scope`/`workspace`）与**目标**（`destScope`/`destWorkspace`）：新建时两者相同；编辑时改「所属」只动目标；
- `save()` 三分支：
  1. **搬迁**（编辑且目标 ≠ 源）→ `connections.move`，成功后提示「已把「X」移动到「目标」」（带 warning 时一并显示）；
  2. 目标是项目 → `workspaces.save`（新建连接也走这里）；
  3. 目标是全局 → `connections.save`；
- 保存后同时刷新全局列表与项目列表（源和目标都可能变化），并只对**刚写入的那一条**做连通性探测（沿用 v0.15 的 O(1) 优化）；
- 打开编辑器时若项目列表尚未加载（例如从「全局连接」页点编辑），按需拉取一次 `workspaces.list`，否则「所属」下拉会是空的。

## 四、测试（新增 13 例）

**Host：`tests/workspaces.spec.ts` +8**

| 用例 | 断言要点 |
|------|---------|
| 全局 → 项目 | 源文件清空、目标文件出现、`host` 已更新、**密文与搬迁前逐字节相同** |
| 项目 → 全局 | 反向同样成立 |
| 项目 A → 项目 B（同时改名） | `old-name` 消失、`new-name` 出现在 B |
| 目标同名冲突 | 拒绝，且**两个文件内容逐字节未变** |
| 源条目不存在 | 报"在源位置不存在" |
| 连接体非法 | 拒绝，且目标文件**未被创建** |
| 源与目标同一文件 | 退化为更新（`action: 'updated'`），不产生重复 |
| 缺少工作区 cwd | 报"无法确定配置文件路径"，不猜路径 |

**Client：`tests/client-render.spec.ts` +5**

| 用例 | 断言要点 |
|------|---------|
| 下拉内容 | 含「所属」「全局（所有项目共享）」「项目：my-app」与全局写入目标 |
| 移入项目 | 含「（将更改所属）」「原位置」「密码等机密原样保留」 |
| 提升为全局 | 同样标记为搬迁，并显示原项目路径 |
| 所属未变 | **不**出现「（将更改所属）」「原位置」 |
| 没有可选项目 | 显示说明文案而非空下拉 |

全套 **265/265**（v0.19 为 252）。

## 五、文件变更清单

| 类型 | 路径 | 说明 |
|------|------|------|
| 代码 | `src/config/mutate.ts` | 抽出 `prepareConnection`；新增 `ConnectionTarget` / `MoveOutcome` / `moveConnection` |
| 代码 | `src/rpc/routes.ts` | 新增 `connections.move`（双端白名单校验 + 审计 + warning 透传） |
| 代码 | `src/client/Section.ts` | `EditorState` 增 `destScope`/`destWorkspace`；编辑器「所属」选择器与目标提示；`save()` 搬迁分支；`openEditor()` 按需加载项目；SSH 选项随目标计算 |
| 测试 | `tests/workspaces.spec.ts`、`tests/client-render.spec.ts` | 见上表 |
| 文档 | `docs/CHANGELOG-v0.20-编辑时更改所属.md` | 本文件 |
| 文档 | `docs/PROJECT.md`、`docs/需求设计文档.md` | 索引与 RPC 协议 |

## 六、验证

| 项 | 结果 |
|----|------|
| `tsc --noEmit` | ✅ |
| vitest 全套 | ✅ 265/265 |
| `scripts/verify.mjs` | ✅ 59/59 |
| 沙箱构建三门禁 / `render-client` | ✅ |
| 部署产物哈希（client / routes / mutate） | ✅ 与工作区一致 |

## 七、已知边界

1. **不能搬到未观测到的项目**：目标必须是插件"服务过"的项目（与其他写操作同一套白名单）。需要先在该项目里用过任一 `db_*` 工具。
2. **不迁移项目级 SSH 配置**：搬迁的是连接条目；若连接引用了**源项目私有**的 SSH 配置，目标位置将解析不到它（编辑器会按目标位置重算下拉，请改选全局配置或目标项目自己的配置）。保存时不拦截，连接时会 fail-closed 报错。
3. **`useGlobal` 白名单不会自动更新**：把连接提升为全局后，若某些项目的 `.dsh/db-manager.json` 里 `useGlobal` 是非空白名单，则新提升的全局连接在这些项目里默认不可见 —— 需要手工把名字加入白名单（沿用既有语义，本次未改动）。
4. **两文件非原子**：目标先写、源后删；源删除失败会返回 warning 并保留可恢复状态（重复而非丢失）。
5. **模型侧无对应工具**：`db_add_connection` 只支持"在指定位置新增/覆盖"，不提供搬迁；本功能目前仅 GUI 使用（需要时再扩工具）。
