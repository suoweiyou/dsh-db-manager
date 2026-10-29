# dsh-db-manager 变更记录 v0.17（体验修复：过期构建提示 / SSH 测试 / 结果可见 / 编辑器就近）

**变更日期**: 2026-10-10
**前置版本**: v0.16
**本文定位**: 针对 v0.16 上线后反馈的 4 个问题做修复与补齐。上一区间见 [CHANGELOG-v0.16-SSH隧道.md](./CHANGELOG-v0.16-SSH隧道.md)。

## 一句话总览

| # | 问题 | 类型 | 处理 |
|---|------|------|------|
| 1 | 改了 Host 半区但忘记重启 DSH，只在某个 RPC 404 时才暴露 | feature | 新增**过期构建提示**：Host 启动时对自己的 `lib/` 做内容指纹，页面比对磁盘现状，不一致即显示「请重启 DSH」横幅；连"旧 Host 根本不认识这个接口"也判定为过期 |
| 2 | SSH 配置没法验证密码/密钥是否正确 | feature | 新增**测试连接**按钮与 `sshProfiles.test` RPC：只做「建连 + 主机密钥校验 + 认证」，成功/失败与失败原因都显示在卡片上 |
| 3 | 项目里的「测试」点了没反应，看不到成功与否 | fix | 根因：结果写进了状态但**没有任何地方渲染**，且异常被静默吞掉。现已渲染状态点 + 结论 + 建议，并保留传输层错误 |
| 4 | 点「编辑」后表单出现在最上方，列表下方的行要滚回顶部才能看到 | fix | 编辑器改为**就近内联**：渲染在被编辑那一行的正下方（新建连接则在所属项目卡片内 / 该标签页顶部） |

## 一、过期构建提示（第 1 项）

### 为什么需要

DSH 插件在宿主进程启动时被载入，之后重建产物**不会**影响已运行的进程：

- Client 半区（`src/client`）改动 → 刷新页面即生效；
- Host 半区（工具 / RPC / 连接池）改动 → **必须重启 DSH**。

于是出现典型症状：页面刷新后新界面调用了新 RPC，旧 Host 返回 `未知 RPC 方法`（HTTP 404）。本项目已因此踩坑两次。

### 实现

`src/rpc/build-info.ts`（新增）：

- `runningLibDir()`：由 `import.meta.url` 推导出本模块所在目录的上级（生产即 `<plugin>/lib`，实测 `<plugin>\lib`）；
- `scanArtifacts(dir)`：递归收集 `.js/.mjs/.cjs`，按 (相对路径, 内容) 做 SHA-256，取前 16 位；**用内容而不是 mtime**，所以「编辑器保存但内容未变」不会误报；
- `captureBuildInfo()`：插件 `apply()` 时调用一次，记录加载时刻的指纹与时间；
- `buildStatus(info)`：重新扫描磁盘并给出 `stale`。

RPC `build.status` → `{ available, libDir, loadedAt, loadedHash, currentHash, files, newestMtimeMs, stale }`。

页面侧（`Section.ts`）逻辑分三种情形：

| 情形 | 判定 |
|------|------|
| `stale === true` | 磁盘指纹 ≠ 运行指纹 → 提示两者哈希与文件数 |
| `available === false` | Host 未上报构建信息（更早版本） |
| RPC 调用失败且信息含 `未知 RPC 方法`/`404` | **最强信号**：旧 Host 根本不认识这个接口 → 直接提示「当前运行的是旧版本」 |

最后一条正是本次用户遇到的场景，所以横幅在"Host 太旧"时依然有效（不是先有鸡还是先有蛋的问题）。

**实测**：

```
runningLibDir = <plugin>\lib
files = 32 | bytes = 426059 | hash = f7047573a71e57c4
buildStatus.stale (刚构建) = false
模拟重新构建后 stale = true → 页面显示重启横幅
清理后 stale = false
```

## 二、SSH 配置的「测试连接」（第 2 项）

### 实现

`ssh-tunnel.ts` 重构：把「建连 + 主机密钥校验 + 认证」抽成内部 `connectSsh()`，被两处复用——

- `openSshTunnel()`：建连后再开本地转发（原行为不变）；
- `probeSshProfile()`（新增，导出）：建连成功后立即断开，**不做端口转发**。因此"测试成功"的含义很精确：主机可达 + 主机密钥在 known_hosts 中 + 认证通过。

RPC `sshProfiles.test { name, workspace? }`：

- `workspace` 沿用 fail-closed 路径白名单；
- 与 `connections.test` 一致，**成功与失败都返回 200**，判定放在 `result` 里（`{ name, ok, latencyMs?, errorKind?, message?, hint?, testedAt }`），页面用同一套渲染；
- 写入审计（`sshProfiles.test`，含 endpoint 与认证方式，不含任何机密）。

GUI：「SSH 配置」卡片新增**测试连接**按钮 + 状态点 + 结论行（`可达（120ms…）` / `不可达 — SSH 认证失败（…）`），失败时另起一行显示**建议**（例如"先手动 ssh 一次以写入 known_hosts"）。

**测试**（3 例，进程内 SSH 服务端强制校验密码）：正确密码 → 成功；错误密码 → `auth` 失败；known_hosts 无记录 → 严格校验拒绝。

## 三、项目卡片测试结果不可见（第 3 项）

### 根因（两个叠加）

1. `testSingle()` 把结果写进 `statuses`，但 `renderProjectCard` **从未读取该状态**——点了按钮界面上没有任何变化；
2. 该函数的 `catch {}` 是空的，**连异常都不留痕**，所以即使 RPC 失败也毫无反馈。

### 修复

- 渲染：项目连接行新增状态点 + 结论行（`未测试` / `正在连接…` / `可达（42ms…）` / `不可达 — 原因`），失败时显示 `建议：…`；行上同时标注 `SSH <配置名>` 徽章（v0.16 加了隧道却没在项目视图体现）；
- 行为：`testSingle` 现在会置 `busy`（按钮显示"测试中…"），并在异常时**写入一条失败结果**，不再静默；
- 新增 `testSummary()` 助手，供连接卡片与 SSH 卡片共用同一套措辞。

### 回归测试（关键）

新增 `tests/client-render.spec.ts`：直接调用 `renderProjectCard` / `renderSshCard`，把元素树**扁平化成文本**再断言，等价于"用户是否真的看得到"：

- 未测试 → 含「未测试」；
- 成功 → 含「可达」「42ms」；
- 失败 → 含「不可达」「Access denied for user」「检查密码」；
- busy → 含「正在连接」；
- 内联编辑器插槽与新建连接插槽确实出现在卡片里；
- SSH 卡片含「测试连接」按钮、机密存在标记（**不含机密值**）与失败建议。

## 四、编辑器就近内联（第 4 项）

原先编辑器固定渲染在面板顶部（`children.push(renderEditor(...))`），列表底部的行点「编辑」后必须滚回顶部。

现在改为**在被编辑行的正下方渲染**：

| 场景 | 位置 |
|------|------|
| 全局连接（编辑已有） | 该连接卡片正下方 |
| 全局连接（新增） | 「全局连接」列表顶部（紧邻「+ 添加连接」按钮） |
| 项目私有连接（编辑） | 该连接行正下方，且在该项目卡片内部 |
| 项目私有连接（新增） | 所属项目卡片内（紧邻该卡片的「+ 添加连接」） |
| SSH 配置（编辑/新增） | 该卡片正下方 / SSH 标签页顶部 |

实现方式：把编辑器先构造成元素（`editorElement` / `sshEditorElement`），再用 `editorForGlobalRow()` / `editorForSshRow()` / `ProjectHandlers.editorFor()` / `newEditorSlot` 插到对应位置。选择内联而不是弹窗，是为了避开 `position: fixed` 在被 `transform` 祖先影响时定位失准的风险（该面板层级不可控）。

## 五、测试与验证

| 项 | 结果 |
|----|------|
| `tsc --noEmit` | ✅ |
| vitest 全套 | ✅ **230/230**（v0.16 为 208；新增 build-info 9 例、client-render 10 例、SSH probe 3 例） |
| `scripts/verify.mjs` | ✅ 59/59 |
| 沙箱构建三门禁 | ✅ |
| 部署产物哈希（client / index / routes / build-info / ssh-tunnel） | ✅ 与工作区一致 |
| 过期检测实测 | ✅ 刚构建 false → 模拟重建 true → 清理 false |
| 真实产物路径推导 | ✅ `runningLibDir()` = `<plugin>/lib` |

## 六、文件变更清单

| 类型 | 路径 | 说明 |
|------|------|------|
| 新增 | `src/rpc/build-info.ts` | 内容指纹 + `captureBuildInfo` / `buildStatus` |
| 新增 | `tests/build-info.spec.ts` | 9 例（指纹稳定性、内容/增删变更、过期判定、无目录不误报） |
| 新增 | `tests/client-render.spec.ts` | 10 例（卡片渲染结果可见性） |
| 代码 | `src/db/ssh-tunnel.ts` | 抽出 `connectSsh`；新增 `probeSshProfile`；`SshConnectOptions` |
| 代码 | `src/index.ts` | 启动时 `captureBuildInfo()` 并注入 RPC deps |
| 代码 | `src/rpc/routes.ts` | `RpcDeps.buildInfo`；新增 `build.status`、`sshProfiles.test`（失败也 200） |
| 代码 | `src/client/api.ts` | `BuildStatusResponse` |
| 代码 | `src/client/Section.ts` | 过期横幅；SSH 测试按钮与状态；项目行状态与建议；编辑器就近内联；`testSummary` 助手；导出两个卡片渲染函数 |
| 测试 | `tests/ssh.spec.ts` | fixture 支持强制密码；新增 3 例 probe 测试 |
| 脚本 | `scripts/run-vitest.mjs` | 注册两个新 spec |
| 文档 | `docs/CHANGELOG-v0.17-体验修复与SSH测试.md` | 本文件 |
| 文档 | `docs/PROJECT.md`、`docs/需求设计文档.md` | 能力索引、RPC 协议、GUI 说明 |

## 七、已知边界

1. **过期提示依赖 RPC 可达**：若 Host 连 `connections.list` 都没有（插件未加载），横幅也不会出现（此时页面本身为空并显示加载失败）。
2. **指纹只覆盖 `lib/` 下的 `.js/.mjs/.cjs`**：若部署形态把代码打成别的扩展名或放在别处，检测会退化为"无签名、不报警"（宁可漏报不误报）。
3. **SSH 测试不验证端口转发**：`sshProfiles.test` 只证明"能登录"，不验证跳板机是否允许转发到目标库；真正的转发验证仍需连接卡片上的「测试」（它会走完整隧道）。
4. **内联编辑器不自动滚动**：它在所点按钮下方展开，通常已在视野内；若卡片很长仍可能需要小幅滚动。
