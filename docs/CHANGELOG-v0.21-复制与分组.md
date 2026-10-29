# CHANGELOG v0.21 — 复制连接 + 连接分组与折叠

> 一句话总览：连接卡片新增**「复制」**（同一台服务器加库时免去重填主机/账号/密码/隧道），连接新增展示用 **`group`** 标签，设置页按标签渲染**可折叠分区**，项目下的多个库也能收起。

| 项 | 类型 | 说明 |
|----|------|------|
| 复制连接 | feature | 新 RPC `connections.duplicate` + 写入层 `duplicateConnection()`：从**已存条目**复制，机密与 SSH 隧道逐字节原样搬运、页面不接触凭据；默认命名 `<源名>-副本`（重名递增） |
| 复制入口 | feature | 连接卡片「编辑」旁新增「复制」；复制成功后**直接打开副本编辑器**，改库名保存即可（UPSERT 语义：副本已存在，保存即替换） |
| 连接分组 | feature | 连接 schema 新增展示用 `group`（1–64 字符，两种方言共用）；`connections.list` / `db_list_connections` 透出；`db_add_connection` 支持 `group` 参数 |
| 分组折叠 | feature | 「全局连接」与每个项目的私有连接均按 `group` 渲染可折叠分区（分区头 = 折叠按钮，显示标签/数量/展开状态）；**无任何分组时保持原样**（不出现分区头） |
| 编辑器 | feature | 新增「分组」输入框，带**已有分组名 datalist**（跨全局与所有已知项目收集），避免手误把一组拆成两组 |
| 构建脚本 | fix | `scripts/build-sandbox.mjs` 支持 `export const`（原只支持 class/function/`export {}`），并对多声明 `export const a = 1, b = 2` 显式报错，避免静默只导出首个名字 |

---

## 一、复制连接

### 1.1 为什么在 Host 端复制

「一个服务器上多个库」是最常见的加库场景：主机、端口、账号、密码、SSH 跳板机全都一样，只有库名不同。

复制**必须在 Host 端**完成：页面从来拿不到明文密码（只拿到 `hasPassword: true`），若在页面侧"预填新连接"，密码就得让用户重新输入一遍，等于没有省事。因此：

- Host 读取**已存条目**原样复制，机密（`enc:v1:…`）与 `$ENV:VAR` 引用**逐字节搬运、不解密、不重新加密**；
- 页面只发一个"从谁复制"的请求，全程不接触凭据。

### 1.2 RPC `connections.duplicate`

| 参数 | 说明 |
|------|------|
| `originalName` | **必填**，源连接名 |
| `fromWorkspace` | 可选；源所在项目（省略 = 全局）。过 fail-closed 白名单 |
| `toWorkspace` | 可选；副本落在哪个项目（省略 = 与源同一位置）。过白名单 |
| `name` | 可选；显式新名。**重名即拒绝**（与 save 同约定） |
| `defaultDatabase` / `group` | 可选覆盖；传 `null` 或空串表示**清除**该字段 |

- 响应 `{ ok, name, action: 'duplicated' }`；失败 422 + `{ error, warnings? }`；
- 审计记录 `connections.duplicate`，detail 带 `from=/to=`（失败记原因）。

### 1.3 命名与校验

| 情形 | 行为 |
|------|------|
| 未传 `name`，`<源名>-副本` 可用 | 用 `-副本` |
| 未传 `name`，`-副本` 已存在 | 递增 `-副本2`、`-副本3`…（上限 1000 次探测） |
| 传了 `name` 且已存在 | **拒绝**并提示换名（不静默改名） |
| 源连接不存在 | 拒绝并给出源文件路径 |
| 源条目自身不合法（手工编辑坏文件） | 复制结果先过 `connectionSchema`，**拒绝复制**而不是把非法记录扩散到目标文件 |
| 目标文件不可读 | 拒绝（沿用 M5：宁可不动，也不覆盖） |

先读两侧文件 + 校验，全部通过后才写目标文件；只追加一条，源文件**不做任何修改**（复制 ≠ 搬迁）。

### 1.4 页面流程

```
点击「复制」→ POST connections.duplicate { originalName }
            → 重新拉取列表（拿到副本的真实视图）
            → openEditor(副本)      ← 用户改库名/改所属，保存即替换
            → 提示「已复制为「X-副本」（含密码与隧道配置）——改成目标库名后保存即可」
```

复制后**列表立即刷新**（副本已落盘，即使随后取消编辑也存在），提示语明确说明"含密码与隧道配置"。

---

## 二、连接分组与折叠

### 2.1 `group` 字段

- `baseCommon` 中新增 `group: z.string().min(1).max(64).optional()`，MySQL/PG/SQLite 三种方言一致；
- **展示用**：不参与连接解析、不影响默认连接选择、不参与驱动身份指纹；
- 语义是"存在即有效"：没有独立的分组注册表，某个标签只要还有连接在用就存在，删掉最后一个连接分组自然消失，无需清理；
- 空串/纯空白视为未分组（schema 层拒绝空串，读取侧对历史数据仍按未分组处理）。

### 2.2 渲染

- `groupConnections()`：按标签分桶，**命名分组按 locale 排序在前，未分组桶固定最后**；桶内保持调用方顺序（列表已按名称排序）；
- 只要存在**至少一个**命名分组，就渲染分区；一个都没有时保持原样的平铺列表（不引入噪音）；
- `renderGroupSection()`：分区头本身是折叠按钮，显示 `▾/▸` + 标签 + 数量徽章 + 「收起/已收起」，折叠后**标题与数量仍可见**（知道藏了什么）；
- 「未分组」桶显示为 `未分组`；
- 两个标签页共用同一套函数：全局列表与 `renderProjectCard` 内的私有连接都按分组渲染。

### 2.3 折叠状态的键空间（含一处实现修正）

折叠状态是页面局部状态（`collapsedGroups: Record<string, boolean>`），键必须**按来源隔离**——否则"项目 A 的 生产库"会连带收起"项目 B 的 生产库"。

实现过程中测试抓到一个真实错误：最初写成 `stateKey('group', label, workspace)`，而 `stateKey` 是**按 scope 分支**的（只有 `scope === 'workspace'` 才把工作区路径编进键），传 `'group'` 会让工作区**被丢弃**，两个项目的同名分组共享一个折叠键。现修正为：

```ts
groupStateKey(label, workspace):
  name = `group:${label ?? '__ungrouped__'}`
  workspace === undefined ? stateKey('global', name) : stateKey('workspace', name, workspace)
```

- 键形如 `g␟group:生产库` / `w␟D:/proj/a␟group:生产库`；
- 独立的 `group:` 命名空间还顺带避免了另一种碰撞：连接**本身**叫「生产库」时其卡片键是 `g␟生产库`，与分区键不再相同（两者曾会作为兄弟节点共用同一个 React key）。

### 2.4 编辑器

「分组」字段与「备注」同排，带 `datalist` 建议项；建议项来自**全局列表 + 所有已知项目**的现有 `group` 值（去重排序）。保存时空值**省略该键**——因为 Host 侧保存是"整体替换"，省略即清除（这也正是页面上清空分组能生效的原因）。

---

## 三、测试（新增 16 例，vitest 281/281）

### 3.1 宿主侧 `duplicateConnection`（6 例，`tests/workspaces.spec.ts`）

| 用例 | 覆盖 |
|------|------|
| 密文逐字节一致 + 默认 `-副本` 名 | 断言副本 `password` 与源**完全相同**（`enc:v1:` 原样），host/库/分组继承 |
| 自动避重 | `-副本` → `-副本2` → `-副本3` |
| 显式重名 | 拒绝 + 报错含「同名连接」+ **目标文件字节不变** |
| 覆盖与清除 | `defaultDatabase`/`group` 覆盖；传 `''`/`null` 清除 |
| 跨文件复制 | 项目 → 全局：密文保留、`group` 覆盖生效、**源项目文件条数不变** |
| 源缺失 / 源非法 | 报错含「不存在」；手工写入的非法条目被拒绝复制且不落盘 |

### 3.2 客户端（10 例，`tests/client-render.spec.ts`）

| 用例 | 覆盖 |
|------|------|
| 复制按钮 | 卡片含「复制」，busy 时为「复制中…」；**SSH 配置卡片没有**该按钮（不支持复制 SSH 配置） |
| 分桶与排序 | 命名分组按序在前、未分组最后、桶内保序、空白标签归未分组 |
| 键空间 | `g␟group:生产库` / `w␟D:/proj/a␟group:生产库`；不同项目不同键；**与同名连接的卡片键不同** |
| 分区渲染 | 展开含标签+数量+卡片名；折叠保留标题与数量、**不含卡片名**；未分组桶显示「未分组」 |
| 项目卡片内分组 | 一个项目多条连接 → 渲染出分组头；且 `collapsedGroups` 命中时该组内容消失、未分组组不受影响 |

---

## 四、文件变更清单

| 类型 | 路径 | 说明 |
|------|------|------|
| 代码 | `src/config/schema.ts` | `baseCommon` 新增 `group` |
| 代码 | `src/shared/types.ts` | `ConnectionSpec.group` |
| 代码 | `src/config/mutate.ts` | 新增 `duplicateConnection()` + `DuplicateOutcome` |
| 代码 | `src/rpc/routes.ts` | 新增 `case 'connections.duplicate'`（双端白名单 + 审计）；`connectionView` 透出 `group` |
| 代码 | `src/tools/index.ts` | `db_list_connections` 视图/schema 透出 `group`；`db_add_connection` 新增 `group` 参数；`replace` 描述明确"整体替换" |
| 客户端 | `src/client/api.ts` | `ConnectionListItem.group`、`SaveArgs.connection.group` |
| 客户端 | `src/client/Section.ts` | `EditorState.group`；`groupConnections` / `groupStateKey` / `renderGroupSection` / `renderGrouped`；卡片「复制」；全局与项目两侧分组渲染；编辑器「分组」+ datalist；`refresh`/`loadWorkspaces` 返回数据供复制流程复用 |
| 构建 | `scripts/build-sandbox.mjs` | 支持 `export const`；多声明导出显式报错 |
| 测试 | `tests/workspaces.spec.ts` | +6 例（复制语义） |
| 测试 | `tests/client-render.spec.ts` | +10 例（复制按钮、分桶、键空间、折叠、项目内分组） |
| 文档 | `docs/需求设计文档.md` | FR-1 补 `group` 字段；FR-20/FR-21；RPC 段新增 `connections.duplicate`、`connections.save` 整体替换说明、`connections.list` 字段 |
| 文档 | `docs/PROJECT.md` | 变更日志索引 |
| 文档 | `docs/CHANGELOG-v0.21-复制与分组.md` | 本文件 |

---

## 五、验证

| 项 | 结果 |
|----|------|
| `tsc --noEmit` | ✅ 0 错 |
| vitest 全套 | ✅ **281/281**（v0.20 为 265） |
| `scripts/verify.mjs` | ✅ 59/59 |
| 沙箱构建三门禁 | ✅ host 63 文件；client 注册/导出/渲染门禁通过 |
| 产物 | `lib/client.js` 73306 → **81816** 字节 |

---

## 六、已知边界

1. **不支持复制 SSH 配置**：SSH 卡片没有「复制」按钮（跳板机配置通常一两台，重复价值低；且其三种机密字段的复制语义需要单独确认）。
2. **复制后取消编辑会留下副本**：副本在点击「复制」时即已落盘（这样即使编辑器保存失败也不会丢），取消编辑只关闭表单；多余的副本可在卡片上直接删除。
3. **`db_add_connection` 的 `replace: true` 是整体替换**：未传的 `comment`/`group`/`sshProfile` 会被清空（工具描述已明确）。这是保存语义的既有设计（也正因如此，"清空分组"才能通过省略字段实现）。
4. **分组只是标签**：不做权限、不做默认连接、不做排序权重；同名标签在任何位置都视为同一组（跨全局/项目共用一个建议列表，但折叠状态按来源隔离）。
5. **分组名 64 字符上限**：超长在 schema 层被拒绝（GUI 输入框未做前端截断，保存时报错提示）。
