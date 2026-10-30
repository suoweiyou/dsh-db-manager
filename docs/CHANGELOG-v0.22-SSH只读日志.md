# dsh-db-manager 变更记录 v0.22（SSH 只读日志源）

**变更日期**: 2026-10-30
**前置版本**: v0.21.1
**本文定位**: 新增「在对话里读服务器日志」能力（FR-22）——SSH 配置声明日志源白名单，模型用 4 个工具按名称读日志/跨源检索关键字；上一区间见 [CHANGELOG-v0.21.1-SSH空口令与known_hosts命令.md](./CHANGELOG-v0.21.1-SSH空口令与known_hosts命令.md)，设计全过程见 [开发计划-20261029-SSH只读日志.md](./开发计划-20261029-SSH只读日志.md)。

## 一句话总览

| 项 | 类型 | 主题 | 用户感知 |
|---|---|---|---|
| F1 | feat | SSH 配置新增 `logSources[]` 日志源白名单（file / journal，可 `via` 第二跳） | 设置页 SSH 编辑器多一个文本框，一行一条；卡片显示「日志源 N」徽章 |
| F2 | feat | 4 个模型工具：`db_list_ssh_logs` / `db_read_ssh_log` / `db_search_ssh_logs` / `db_add_ssh_log_source` | 对话里直接说「看下 app 日志」「这个 traceId 在哪些日志里出现」，不用再让用户手工贴日志 |
| F3 | feat | 输出额度单配置 `logMaxBytes`（默认 100000 = 100KB） | 一个输入框调大小；超了保留最新行并标 `truncated` |
| S1 | security | 只读且无 shell：file = SFTP 定长 tail；journal = 固定模板 argv | 模型拿不到路径与命令，只能给名称；读不到白名单外的任何文件 |

## 正文

### 设计定位：读日志发生在对话里，不在 GUI

上一版讨论里曾设想过「连接卡片加一个『查看日志』按钮 + 面板」，实现时否决了：真正的痛点是**模型看不到服务器日志，只能靠用户复制粘贴**，而面板只是把日志搬到了另一个窗口，分析仍要人工中转。因此本版只做两件事：**GUI 负责声明白名单**（一个文本框），**模型负责读并分析**（4 个工具）。页面上没有任何日志读取入口。

### F1 日志源白名单：路径与命令只存在于配置

`sshProfiles[]` 每条配置新增可选 `logSources[]`，每条源：

| 字段 | 说明 |
|---|---|
| `name` | 源名，同一配置内唯一（模型读日志时只传它） |
| `kind` | `file`（普通日志文件）或 `journal`（systemd 单元） |
| `path` | `kind=file` 必填，**绝对 POSIX 路径**（拒绝相对路径与含 `.`/`..` 段的路径） |
| `unit` | `kind=journal` 必填，`[A-Za-z0-9@._:-]{1,64}` |
| `label` | 可选说明，只在列表里显示 |
| `via` | 可选：真正存日志的是**第二台机器**（经本配置的 host 转发过去），值为另一条 SSH 配置名 |

校验（`src/config/schema.ts`）：`kind` 与目标字段必须匹配（file 不许带 `unit`，journal 不许带 `path`）、同一配置内重名拒绝、`via` 不得指向自身、每条配置最多 20 条。配置层解析（`src/config/store.ts#resolveLogSource`）只按名字查表，报错时列出可用名（"可用：jump、db-host"），配置里一条源都没有时给专门文案（"尚未登记任何日志源"）。

GUI：SSH 编辑器底部新增多行文本框，格式 `名称 | file|journal | 路径或 unit | 说明 | via=配置名`；`parseLogSourcesText()` 逐行解析并按行号报错，`formatLogSources()` 负责回填。新增 `connections.list` 视图字段 `logSourceCount`（卡片徽章）与 `logSources`（编辑器回填，只有路径/单元名，无凭据）。

「SSH 配置」页顶部说明同步改写：原来只说「先连跳板机、再连数据库」，读日志上线后这句话已不完整——改为两类用途并列（① 数据库走隧道；② 在对话里读服务器日志，登记日志源后按名称读取、只读且不下发命令），并说明同一条配置可两者兼用；顺手修掉同一说明框里 `**严格校验**` 的星号（该节点是纯文本，没有 Markdown 渲染，星号会原样显示）。

**合并保护**（`src/config/mutate.ts#saveSshProfileInto`）：编辑器保存走"整体替换"，若调用方没带 `logSources`（例如只改密码的旧版页面、或 `db_add_connection` 之外的 RPC 调用），Host 会从**已存条目**把白名单补回来；只有显式传 `[]` 才清空。没有这一层，一次"改个密码"的保存就会把白名单静默清空。

### F2 四个工具

| 工具 | 用途 |
|---|---|
| `db_list_ssh_logs()` | 有哪些配置/源可用（名称、kind、目标、via、label），以及配置校验警告 |
| `db_read_ssh_log({ profile, source, lines?, keyword?, since? })` | 读某个源的尾部窗口并带回对话；`keyword` 在窗口内本地过滤，`since` 仅 journal 源 |
| `db_search_ssh_logs({ keyword, profile?, sources?, contextLines?, ... })` | 一个关键字跨多个源一次检索，用于顺着 traceId / 错误码找下游日志 |
| `db_add_ssh_log_source({ profile, name, kind?, path?, unit?, label?, via?, scope?, delete? })` | 对话中直接登记/删除日志源（等价于设置页那个文本框），只改该配置的 `logSources` |

关键约定：

- **有界读取**：`lines` 默认 200（硬上限 2000），单行超过 2000 字符截断；file 源按 `maxBytes` 计算 `start` 后只读那一段（`sftp.stat` + `createReadStream({ start, end })`），journal 源用 `journalctl -n N`。
- **"没命中"必须可分辨**：返回 `scannedLines`（窗口里共多少行）、`matched`、`windowBytes`、`truncated`，工具描述与渲染都写明"keyword 是窗口内过滤，不是全文检索"。
- **跨源分摊额度**：`db_search_ssh_logs` 把 `logMaxBytes` 按目标源数量分摊（每源至少 4KB）；额度用尽的源明确标"该源未检索：请缩小 sources 范围重试"，而不是静默返回空结果。
- **会话复用**：一次工具调用内，同一目标机（同 `profile` + 同 `via`）的所有源共用一个 SSH 会话（`openLogSession`），调用结束即关闭；不缓存、不进连接池（D8）。

### F3 输出额度就是一个数字

只增加一个配置项 `logMaxBytes`（默认 `100000`，范围 1000..1000000）。之前设想的"按对话上下文自适应"方案被明确否决——模型上下文长度对插件不可知，猜错反而更差；100KB 对"读懂一段报错栈 + 前后几十行"足够，超出时保留**最新**的行（排障看尾部），并回报 `maxBytes` 与 `truncated`。另有 `logTimeoutMs`（默认 10s，单次读取超时）与 `logEnabled`（默认 true，应急停止用：关掉后 4 个工具不再注册）。

### S1 只读与"没有 shell"

| 面 | 保证 |
|---|---|
| 调用方输入 | 只有**名称**（profile / source）与 `lines` / `keyword` / `since`；路径、命令、账号全部来自配置 |
| file 源 | 全仓库对目标机只有 `sftp.stat` + `createReadStream`，**不存在** write / unlink / rename / mkdir 调用点 → 写能力在代码层面不存在 |
| journal 源 | 固定模板 `journalctl --no-pager --output=short-iso -n N [-u <unit>] [--since '<t>']`；`unit` 落盘前与执行前各校验一次字符集，`since` 只接受 `-30min` 形态或 `YYYY-MM-DD[ HH:MM[:SS]]`，校验后单引号包裹；**从不拼接调用方字符串、从不经 shell** |
| 关键字 | 只在 Host 端本地过滤，绝不下发 `grep`（否则等于把用户输入变成远端命令） |
| 主机密钥 | 复用 v0.16 的严格 known_hosts 校验，无 TOFU、无跳过开关 |
| 审计 | 只记 `profile` / `source` / `kind` / 窗口字节 / 行数 / 是否截断；**不记日志正文，也不记 keyword** |

### UI 修正：设置页三个标签的选中态会叠加

现象：设置页顶部三个标签（全局连接 / 项目 / SSH 配置）刚打开时只有「全局连接」是深色边框，另外两个是浅灰；但点过几次之后三个都成了深色边框，看不出当前在哪一页。

原因：选中样式写成「`buttonStyle` 提供 `border` **简写** + 选中分支追加 `borderColor` **长写**」，且选中色用的是 `label-secondary`（浅色主题下接近纯黑）。两条合并成一条样式时，简写与长写混用会让切换标签后的旧标签保留上一次的深色边框。

改法（`src/client/Section.ts#tabButton`）：

- 两个分支都写**完整的 `border` 简写**，不再与 `borderColor` 长写混用——这是这次残留的根因；
- 选中色改用主题的「ghost 按钮激活态」token：边框 `--dsw-alias-button-ghost-active-border`、底色 `--dsw-alias-button-ghost-active-fill`，分别以 `label-secondary` / `interactive-bg-hover` 兜底（老主题上仍是原来的观感），深色与浅色主题都跟随；
- 未选中态显式写 `background: transparent`、`color: textSecondary`、`fontWeight: 400`，选中态 `fontWeight: 600`——即使色觉受限或主题色接近，靠字重也能分辨当前标签；
- 顺手补 `type="button"`、`aria-pressed` 与 `title`（「当前标签：…」/「切换到…」）。

### UI 修正：「全部测试」测完了却什么也看不到（并发 4 逐条落地）

现象：点顶部「全部测试」，按钮转一会儿，卡片上的状态点却一动不动——之前单条「测试」点出来的绿点/红点还会被一起清空，回到灰色「未测试」。

根因有两层，其中第一层是**key 写读不一致**（v0.17~v0.20「卡片体验统一」重构引入的回归）：

| 环节 | 原来用的 key |
|---|---|
| 卡片读取（`bindCard`） | `statuses[stateKey(scope, name, workspace)]` → `statuses['g␟mydb']` |
| 单条「测试」写入 | `statuses[key]` ✅ |
| 「全部测试」/`connections.status` 写入 | `statuses[result.name]` → `statuses['mydb']` ❌ |

写进 `mydb`、读的是 `g␟mydb`，于是批量结果没有任何卡片认领；而写入又是**整体替换**（`setStatuses(map)`），所以跑一次反而把单条测试的结果抹掉。

第二层是批量本身的设计：主机侧一次扇出 `connections.testAll`（并发 8、单条等待写死 `min(connectTimeoutMs, 2s)`），只能整批返回——过程中界面不动、一条挂死的跳板机（SSH `readyTimeout` 默认 20s，不受那个 2s 约束）会把整批拖到前端 `AbortSignal.timeout(30_000)`，已经算出来的结果全部丢弃；由于 2s 上限比单条「测试」的 5s（默认 `connectTimeoutMs`）更严，同一个库会出现「单条可达 31ms、全部测试连接超时」。

改法：

- **批量改由页面驱动**：`Section.ts#testAll` 对当前列表逐条调用 `connections.test`，并发 **4**（`TEST_ALL_CONCURRENCY`，抽出 `runPool` 便于单测），每拿到一条就 `setStatuses(prev => ({ ...prev, [key]: result }))` 并刷新按钮上的进度（`测试中 3/25`），收尾用一句 `notice` 汇总「N 条中 M 条不可达」；单条超时沿用连接的 `connectTimeoutMs`，与卡片「测试」完全一致；
- **主机侧删掉 `connections.testAll`**（连同 `findSpecAll` 与两个常量），RPC 只剩单条测试，避免两条行为不同的批量路径并存；
- **状态 key 统一**：新增 `statusMapFrom()`，`connections.status` 的缓存结果一律按 `stateKey` 折叠，并改为**合并**写入；`runPool` 里一条 worker 抛错不会中断整批；
- **缓存结果带来源**：`ConnectionTestResult` / `TestResultView` 增加可选的 `scope` 与 `workspace`（仅 RPC 层写入，`db_test_connection` 输出形状不变），主机 `statusCache` 也改成按 `g␟name` / `w␟path␟name` 存——否则同名全局连接与项目连接会互相覆盖结论。

测试：`tests/client-test-all.spec.ts`（10 例）钉住并发上限恰好 4、每条只跑一次、worker 抛错不带走整批、`concurrency` 传 0 退化为串行，`statusMapFrom` 的三种 key（全局 / 项目同名 / 老宿主缺 `scope`），以及 `pruneStatusMap` 只丢弃没有卡片的结论。

### 实现中修正的两处设计

1. **SFTP 改为按需打开**：原实现在 `openLogSession` 里无条件 `client.sftp()`，于是只配了 journal 源的机器（很多生产机禁用了 sftp subsystem）连"读 journal"都失败。改为第一次读到 file 源时才开 SFTP，报错文案保留"可改用 kind=journal 的日志源，或联系运维开启 sftp subsystem"。测试 `openLogSession — journal end-to-end` 正是钉住这一点：夹具服务器只实现 `exec`，不实现 `sftp`。
2. **`since` 相对时间正则**：初版 `/^-\d{1,4}[smhd]$/` 只认 `-2h`、`-7d`，把文档里写的 `-30min` 判成非法。改为 `/^-\d{1,4}(s|m|h|d|sec|min|hour|day)s?$/i`，与工具描述、报错文案一致。

## 文件变更清单

- 新增：`src/db/ssh-log.ts`（传输 + 纯函数）、`src/tools/logs.ts`（4 个工具）、`tests/ssh-logs.spec.ts`（37 例）、`tests/client-test-all.spec.ts`（10 例：批量池、状态表 key 与刷新剪枝）
- 修改：`src/shared/types.ts`（`SshLogKind` / `SshLogSourceSpec` / `SshProfileSpec.logSources`；`ConnectionTestResult` 增 `scope`/`workspace`）、`src/config/schema.ts`（`sshLogSourceSchema` + 白名单规则）、`src/config/store.ts`（`resolveLogSource` / `visibleSshProfiles`）、`src/config/mutate.ts`（`saveLogSourceInto` + 保存时的白名单合并保护）、`src/db/ssh-tunnel.ts`（导出 `connectSsh` / `SshConnection`，新增 `sock` 选项与 `permission` 错误类）、`src/tools/index.ts`（装配 + 自审清单）、`src/index.ts`（3 个配置项）、`src/rpc/routes.ts`（SSH 视图带 `logSourceCount` / `logSources`；删除 `connections.testAll`，状态缓存改按 `g␟name` / `w␟path␟name` 存，`connections.test` 结果带 `scope`/`workspace`）、`src/client/api.ts`（`TestResultView` 增 `scope`/`workspace`）、`src/client/Section.ts`（白名单文本框 + 徽章 + 解析/格式化 + 「SSH 配置」页说明文案 + 三个标签的选中态修复 + 「全部测试」改为并发 4 逐条落地 + `statusMapFrom` / `runPool`）
- 测试：`scripts/run-vitest.mjs` 挂载新 spec
- 文档：README 精简重写（135 → 109 行：改成「独立简易版定位 + 功能表 + 13 工具清单 + 界面/对话示例」结构，删掉版本演进史与兼容性判定长文，补上 v0.22 日志能力；新增 `docs/img/img-db.png`、`docs/img/img-log.png` 两张对话示例截图，`screenshots.json` 由 4 张增至 6 张）、本文、`docs/需求设计文档.md`（FR-22 + §5.1/§5.2/§5.3/§6.7/§8.1/§8.3/§9/§11）、`docs/PROJECT.md` 索引行、`docs/开发计划-20261029-SSH只读日志.md` 落地状态
- 版本：`package.json` → `0.22.0`

## 运行验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | exit 0，无错误 |
| 单测全量 | `node --import ./scripts/register-vitest-shim.mjs scripts/run-vitest.mjs` | **335/335 通过**（v0.21.1 基线 288 + v0.22 日志 37 + 全部测试批量 10，含 journal 端到端、工具装配、工具级读取与审计脱敏、并发池与状态 key） |
| 核心验证 | `node scripts/verify.mjs` | 59/59 通过 |
| 构建 | `node scripts/build-sandbox.mjs` | host `lib/` 67 文件、client `lib/client.js` 92568 字符 / 97264 字节，gate 通过（`apply`/`inject`/`13` 处 `createElement`） |

新增单测覆盖：`tailWindow` 尾部/字节上限/半行丢弃/CRLF/空文件、`filterKeyword` 与 `clampLine`、`journalArgv` 固定模板与元字符拒绝、`since` 两种形态、schema 白名单全部拒绝分支、`resolveLogSource` 名称解析与工作区优先、保存时的白名单合并保护（省略保留 / `[]` 清空）、`saveLogSourceInto` 增/改/删与非法源拒绝、页面文本 parse↔format 往返与行号报错、journal 端到端（断言发给服务器的命令逐字等于固定模板）。

另有 `tests/client-test-all.spec.ts`：`runPool` 并发上限恰好 4、每条只跑一次、worker 抛错不中断整批、`concurrency` 传 0 退化为串行；`statusMapFrom` 的三种 key（全局 `g␟name` / 项目同名 `w␟path␟name` / 老宿主缺 `scope` 退回全局），以及 `pruneStatusMap`（删除连接后旧绿点不留存、项目结论不受全局刷新影响）。

**未自动化**：SFTP file 源的真实读取。原因是在测试里实现一个 ssh2 SFTP 服务端需要手写 SFTP 协议包（OPEN/READ/STAT/FSTAT），成本高于收益；该路径由 `tailWindow` / `readFileTail` 的参数化单测 + 下面的人工验证覆盖。

**人工验证（发布前，owner 执行）**：

1. 在一台 Linux 机器上准备 `/tmp/dbm-demo.log`（几百行）与一个 systemd 单元；
2. 设置页 SSH 配置填两行：`demo | file | /tmp/dbm-demo.log`、`demo-journal | journal | <unit>`，保存后卡片出现「日志源 2」；
3. 对话里 `db_list_ssh_logs` → 两个源都在；`db_read_ssh_log {profile, source:"demo"}` 返回尾部行；`keyword` 命中数 < 窗口行数时 `truncated=true`；
4. `db_search_ssh_logs {keyword:"ERROR"}` 两个源都有结果；把 `logMaxBytes` 调到 4000 再试，应看到截断提示与分摊后的结果；
5. 故意把路径改成相对路径保存 → 表单按行报错；用 `db_add_ssh_log_source` 登记一条再删除，配置文件里 `logSources` 应随之增删且 `auth` 段落原样不变。

## 已知边界（记录在案，非漏洞）

- `keyword` 只在本次读到的尾部窗口内匹配，不是全文检索（见 `docs/需求设计文档.md` §8.3 第 10 条）。
- 日志正文会进入对话上下文，可能含个人信息/令牌；插件只保证"有界窗口 + 白名单 + 审计不含正文"，脱敏依赖服务器侧日志规范。
- `kind=file` 需要目标机开启 SFTP 子系统；`kind=journal` 需要 systemd 且运行账号对该 unit 有读权限。两者都受 SSH 账号的 OS 权限约束，插件不提权。
- 20 条源/配置的上限是"够用且好审"的经验值；需要更多时应拆成多条 SSH 配置而不是放宽。
- 第二跳（`via`）的认证与 known_hosts 用 `via` 那条配置自己的设置，因此要求该配置本身可用（能直接 SSH 到目标机）。
