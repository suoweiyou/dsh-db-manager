# dsh-db-manager 变更记录 v0.18（项目连接与全局共用同一张卡片）

**变更日期**: 2026-10-10
**前置版本**: v0.17
**本文定位**: 「项目」标签页里的数据库连接改为与「全局连接」**完全共用同一张卡片**，因此也获得了查看表结构（表清单 / 列 / 索引 / DDL）、使用明细等功能。上一区间见 [CHANGELOG-v0.17-体验修复与SSH测试.md](./CHANGELOG-v0.17-体验修复与SSH测试.md)。

## 一句话总览

| 项 | 类型 | 说明 |
|----|------|------|
| 共用卡片 | feature | 两个标签页都由 `renderCard()` 渲染，连接的操作/状态/徽章/浏览面板完全一致 |
| 项目连接可查看表 | feature | `tables.list` / `tables.describe` 支持 `workspace`，项目私有连接也能列出表、看列/索引/DDL |
| **正确性修复** | fix | 浏览 RPC 原先只查全局文件：项目连接要么报"不存在"，**要么在同名时静默解析到全局连接**（看到的是另一个库的表） |
| 状态隔离 | fix | 状态/浏览面板/使用明细的键由「连接名」改为「来源 + 项目路径 + 连接名」的复合键 |
| 健壮性 | fix | Windows 下原子写的 rename 偶发 `EPERM`（杀毒/索引器占用）→ 增加有限重试 |

## 一、为什么"共用卡片"不只是复用 UI

「项目」标签页原先手写了一个精简行（名称、方言、endpoint、SSH 徽章、测试/编辑/删除），所以项目连接**没有**「查看表」。但把按钮搬过去还不够——真正的阻塞在 Host 侧：

```ts
// 改前：只看全局文件
export function resolveSpecForRpc(store, name) {
  const found = store.load().global.data?.connections.find((c) => c.name === name)
  ...
}
```

后果有两级：

1. 项目私有连接 → 报"连接不存在"（功能缺失）；
2. **项目连接与全局连接同名时 → 静默解析到全局连接**，于是「查看表」显示的是**另一个库**的表结构。这不是显示错误，而是"你以为在看 A 库、实际在看 B 库"的误导，必须一并修掉。

因此本次改动 = Host 侧解析/协议 + Client 侧渲染/键控，两侧一起改。

## 二、Host 侧

| 改动 | 说明 |
|------|------|
| `resolveSpecForRpc(store, name, workspace?)` | 传入项目路径时**先查项目文件、再回落全局**，与运行时的同名覆盖语义一致；未传时行为不变（仍只查全局） |
| `browseTablesForRpc(..., workspace?)` / `describeTableForRpc(..., workspace?)` | 项目上下文参与「连接解析 + SSH 配置解析」，两者都不会漏掉项目级定义 |
| RPC `tables.list` / `tables.describe` | 新增可选 `workspace`；沿用 **fail-closed 路径白名单**（只能操作插件观察到的项目），非法路径直接 422 |
| 审计 | 成功记录里带上「（项目 &lt;path&gt;）」便于追溯 |

失败信息也区分了来源：项目上下文下报 `项目连接 "x" 不存在（项目：D:/…）`。

## 三、Client 侧

### 3.1 复合状态键（避免同名互相干扰）

```ts
stateKey(scope, name, workspace?) →
  'w\u241f<项目路径>\u241f<连接名>'   // 项目连接
  'g\u241f<连接名>'                  // 全局连接
```

测试状态、查看表面板、使用明细展开状态全部改用该键；`\u241f` 是单元分隔符，不会出现在连接名或路径里。

### 3.2 统一绑定与渲染

- `bindCard(item, workspace?)`：把一条连接绑定成 `CardBinding`（状态、使用明细、浏览面板、测试/编辑/删除/查看表回调、busy/确认态），全局与项目走**同一个函数**；
- `renderBoundCard(binding)`：唯一入口，内部调用 `renderCard()`；
- 「项目」标签页的 `ProjectHandlers` 因此精简为 `cardKeyFor` + `renderConnectionCard` + 编辑器插槽（原先的 `busy/statusOf/onEdit/onTest/onDelete*` 全部移除）；
- 删除死代码 `testOne()`（单一测试已统一走 `testSingle(key, name, workspace)`）。

### 3.3 卡片自身的小幅增强

| 项 | 改前 | 改后 |
|----|------|------|
| 来源徽章 | 硬编码「全局」 | 按 `item.scope` 显示「全局 / 项目」 |
| SSH 标记 | 只有项目行有 | 卡片统一显示 `SSH <配置名>` |
| SQLite | 显示 `undefined:undefined` | 不显示 host:port，只显示文件路径 |
| 字段非法 | 只有项目行有 | 卡片统一显示「字段不合法」 |
| 测试中 | 只有按钮变文案 | 状态行显示「正在测试（建立连接/隧道）…」 |

### 3.4 两个标签页现在一致的能力

测试 · 查看表（表/视图清单）· 查看 DDL（列 + 索引 + DDL）· 收起表 · 使用明细（会话/工作区关联）· 编辑 · 删除（含二次确认）· 字段非法标记 · SSH 徽章。唯一的差异是来源徽章与写入目标（项目文件 vs 全局文件）。

## 四、顺带的健壮性修复：原子写的 rename 重试

测试过程中出现一次偶发失败：

```
EPERM: operation not permitted, rename '…\.dsh\db-manager.json.tmp-24044' → '…\.dsh\db-manager.json'
```

Windows 上 `fs.renameSync` 的目标文件被杀毒/索引器/编辑器短暂占用时会报 `EPERM`/`EBUSY`/`EACCES`，属于**瞬时**错误，但会让用户看到一次莫名的"保存失败"。

新增 `renameWithRetry(from, to, rename?, attempts = 5)`：

- 仅对 `EPERM`/`EBUSY`/`EACCES` 做退避重试（20/40/60/80ms，同步等待用 `Atomics.wait`）；
- 其它错误（如 `ENOENT`）立即抛出不重试；
- **不降级为非原子写**——原子性保证不变，只是多等一会儿；
- 最终仍失败时清理临时文件再抛出。

## 五、测试

| 文件 | 数量 | 覆盖 |
|------|------|------|
| `tests/client-render.spec.ts` | 19（原 10） | 卡片来源徽章、**项目卡片内含「查看表」与表清单**、状态/建议/测试中、SQLite 不显示端点、使用明细、SSH 徽章、`stateKey` 三向隔离、`renderBoundCard` 全套操作、项目卡片内联编辑器插槽 |
| `tests/rpc-tables.spec.ts` | 10（原 6） | **项目连接解析**：仅项目存在 / 同名时项目优先（全局仍解析到全局）/ 失败信息带项目路径 / 浏览助手段到端接受项目上下文 |
| `tests/workspaces.spec.ts` | 18（原 14） | `renameWithRetry`：三类瞬时错误重试成功、非瞬时错误不重试、超出预算抛错、真实 rename 正常路径 |

全套 **247/247**（v0.17 为 230）。

## 六、文件变更清单

| 类型 | 路径 | 说明 |
|------|------|------|
| 代码 | `src/rpc/routes.ts` | `resolveSpecForRpc` 支持项目优先解析；两个浏览助手与两个 RPC 支持 `workspace`（白名单 + 审计） |
| 代码 | `src/client/Section.ts` | `stateKey` / `CardBinding` / `renderBoundCard` / `bindCard`；项目卡片改用共享卡片；卡片增强（来源·SSH·非法·SQLite·测试中）；`testSingle(key, …)`；移除 `testOne` |
| 代码 | `src/config/mutate.ts` | 新增 `renameWithRetry`，`writeConfigFile` 用它并清理临时文件 |
| 测试 | `tests/client-render.spec.ts`、`tests/rpc-tables.spec.ts`、`tests/workspaces.spec.ts` | 见上表 |
| 文档 | `docs/PROJECT.md`、`docs/需求设计文档.md` | 索引与 RPC 协议（`workspace` 参数） |
| 文档 | `docs/CHANGELOG-v0.18-项目连接共用卡片.md` | 本文件 |

## 七、验证

| 项 | 结果 |
|----|------|
| `tsc --noEmit` | ✅ |
| vitest 全套 | ✅ 247/247（连续三次运行稳定） |
| `scripts/verify.mjs` | ✅ 59/59 |
| 沙箱构建三门禁 | ✅ |
| `render-client.mjs` | ✅ |
| 部署产物哈希（client / routes / mutate） | ✅ 与工作区一致 |

## 八、已知边界

1. **使用明细仍按连接名聚合**：`usage.json` / 会话统计以连接名为键，因此项目连接与全局连接**同名**时两者共享同一份使用统计（展示层面，不影响浏览/测试的解析）。如需严格区分，需要把使用追踪也改为按 (来源, 项目, 名称) 记录（属于数据格式变更，另行评估）。
2. **「该项目使用过的全局连接」仍是只读列表**：本次只统一了连接卡片本身；项目与全局之间的"引用/导入"操作未变更。
3. **项目连接的「查看表」走同一套只读逻辑**：仍然只读（不提供数据行浏览），与全局一致。
