# dsh-db-manager

DeepSeek Harness（DSH）双端 Cordis 插件：MySQL / PostgreSQL / SQLite 多方言数据库连接注册中心 + 设置页管理 GUI + 安全的 AI 数据查询工具。

让 DSH 会话中的 AI 与开发者共享同一份多项目数据库连接：**管理面**在 DSH 设置页提供「数据库」分区，集中查看连接与状态、增删改、连通性测试、**只读表清单与 DDL 浏览**；**数据面**通过 9 个 `db_*` 模型工具覆盖连接注册、连接发现、元数据浏览、只读查询与受控写执行，对话即界面。

## 功能亮点

- **连接管理体验（v0.18 ~ v0.21）**：同一条连接在「全局」与「项目」两个视角下是**同一张卡片**（任一处修改两处同步，不再重复维护）；编辑时可改「所属」，全局 ↔ 项目直接互移；卡片「复制」从**已存条目**克隆连接——默认 `<源名>-副本`、重名自动递增，凭据与 SSH 隧道逐字节搬运、页面全程不接触明文；连接可打 `group` 标签，两个视角都按分组**折叠**展示；SSH 主机密钥不匹配时给出 `known_hosts` 类型诊断与修复指引。
- **SSH 隧道连接（v0.16，FR-13）**：数据库只允许从跳板机访问时，给连接指定一条**可复用**的 SSH 配置即可——先连跳板机，再经隧道连数据库。支持 ssh-agent / 私钥文件（含口令）/ 内联 PEM / 密码四种认证；**主机密钥严格校验**（必须已在 known_hosts，无首次信任、无跳过开关）；本地转发只绑 `127.0.0.1`，隧道随连接池条目一并关闭；SSH 凭据与数据库密码同规则落盘（`$ENV:VAR` 或 AES-256-GCM 密文，页面永不回显）。
- **双视图管理（v0.15）**：设置页分「全局连接」「项目」「SSH 配置」三个标签页——全局连接供所有工作区共享，「项目」按项目分组展示**项目私有连接**（可增删改测，写入 `<项目>/.dsh/db-manager.json`）与该项目**使用过的全局连接**，「SSH 配置」维护可复用的跳板机配置；各页均支持搜索过滤，项目写入按路径白名单 fail-closed。
- **一句话加库（v0.14）**：`db_add_connection` 一次调用完成「校验 → 写配置 → 连通性测试」——传 `name/dialect/host/username/password/…` 即可注册 MySQL / PostgreSQL / SQLite 连接，无需模型自己读配置、手写 JSON 再重载；明文密码由 Host 即时加密落盘，配置里只有密文。
- **多方言一致体验**：连接配置声明 `dialect: mysql | postgresql | sqlite` 即接入对应数据库；工具签名、返回结构、安全行为在三种方言上完全一致。
- **设置页只读表浏览（v0.13）**：连接卡新增「查看表」按钮，浏览器内即可列出某连接默认库的表/视图清单，按表查看列、索引与 DDL（MySQL `SHOW CREATE TABLE` / SQLite `sqlite_master.sql` / PG 系统目录 best-effort 重建）；**只读**——不触碰数据行，不打开库选择器（守住"非目标"边界）。
- **安全基线**：密码在配置文件中只有两种落盘形态——`$ENV:VAR` 环境变量引用或 AES-256-GCM 密文（直接在文件里写明文会被校验层拒绝）；工具入参传入的明文密码由 Host 即时加密后才写盘，凭据始终不进入日志、工具返回与 GUI 回显。默认只读模式；SQL 安全网关（AST 分类 + 规则层）拦截多语句与高危语句。
- **受控写执行**：UPDATE/DELETE 执行前按策略自动影子备份受影响行到同库备份表（三档备份策略，默认 `small-only`）；高危语句走「宿主人工审批 / HMAC 确认令牌」闭环。
- **可观测**：全部工具调用与 GUI 配置变更写入按天滚动的 JSONL 审计日志（凭据打码）；连接卡片显示会话/工作区使用关联。
- **零工具链部署**：MySQL/PostgreSQL 走 Node-API prebuilt，SQLite 使用 Node 22+ 内置 `node:sqlite`——无 native binding 编译，无 prebuilt 下载，部署仅要求 Node ≥ 22。

## 文档

| 文档 | 内容 |
|------|------|
| [docs/需求设计文档.md](docs/需求设计文档.md) | 需求、场景、功能清单、GUI/RPC/工具协议、技术方案、安全设计、里程碑与验收、配置使用速查 |
| [docs/PROJECT.md](docs/PROJECT.md) | 项目总览、文档地图、验证基线、变更日志索引（v0.1 → v0.21 逐版摘要） |
| [docs/开发规范.md](docs/开发规范.md) | 技术栈、编码规范、安全红线、测试验证、变更日志规则 |
| [docs/](docs/) | 按版本归档的 `CHANGELOG-*.md`（v0.1 首日全链路 → v0.21 复制与分组，含各补丁版）与 `records/`（PRD 评审纪要、安全审计报告、迭代日志） |
| [docs/发布指南-插件市场.md](docs/发布指南-插件市场.md) | npm 发布与插件市场收录流程 |

## 兼容性：支持的 DSH 版本

本插件声明的 DSH 可用区间（`package.json` 中四处等价声明：`peerDependencies` 的三个 `@deepseek-ai/dsh-*` 与 `dsh.engines.dsh`）——**只跟随 0.2.1 线**：

```
^0.2.1-alpha.2
```

| DSH 版本 | 状态 | 依据 |
|---------|------|------|
| `0.2.1-alpha.2` | compatible | **实测**：安装成功 + 设置页 GUI、RPC、`db_*` 工具全链路验证（2026-10-14 ~ 10-17） |
| `0.2.1-rc.2` | compatible | **实测**：安装门禁通过（`dsh plugin add` 无兼容性拒绝）、Host RPC 路由生效（403 令牌校验）、`db_list_connections` 真实调用成功、客户端契约（`__ModuleLoader__` 信封、`settings.section` 槽位与其 owner props）对着已装 rc.2 包逐条比对一致（2026-10-19） |

**为什么不声明 0.1.x 与 0.2.0**：本插件的清单与客户端代码在 2026-10-14 的「0.2.x 插件契约适配」中改为 `dsh.bundle.patch` + `dsh.client.inject`（依赖 `dsh-client-ui-settings` 的 `settings.section` 槽位）这一形状，此后 0.1.x 与 0.2.0 再未被实测过，也无任何支持依据，故不再声明（原先误标的 `^0.1.7-rc.1 || ^0.2.0-rc.1` 已移除）。

区间语义（预发布版本最容易踩坑）：

- semver 规定**预发布版本只能被同 `major.minor.patch` 元组的比较器匹配**，所以下限必须写成 `0.2.1-alpha.2`（而不是 `0.2.1`）才能让 `0.2.1-rc.2` 通过；同理 `0.2.1-alpha.1` 被拒绝；
- 已逐版本核对边界（DSH 自带 semver 7.8.5）：**接受** `0.2.1-alpha.2` / `0.2.1-beta.1` / `0.2.1-rc.2` / `0.2.1` / `0.2.2` / `0.2.5`；**拒绝** `0.1.7-rc.1` / `0.1.8` / `0.2.0-rc.1` / `0.2.0` / `0.2.1-alpha.1` / `0.3.0`；
- 因此 0.2.1 正式版、0.2.2 等后续 0.2.x 会被区间接受（无需改包即可升级）；等 DSH 契约真有变化时，以实测结论为准并同步 `dsh.compatibility.dshReleases` 台账。

DSH 如何判定兼容（`dsh-app-boot` 的 `unmetRequirements()`）：优先读插件清单的 `engines.dsh`，没有则逐个校验 `peerDependencies` 中 `@deepseek-ai/dsh*` 的区间；不满足时**安装被拒绝并回滚**，可用 `dsh plugin --profile <name> allow-version <包>@<版本> --dsh-version <DSH 版本> --accept-risk` 显式豁免（本插件无需豁免）。本插件的 `dsh.compatibility.dshReleases` 是自留的兼容台账，记录上表"已实测"结论；当前 DSH 版本（0.2.1-rc.2）不读取该字段，实际门禁走上述区间声明（`engines.dsh` 优先，缺失时才看 peer 区间）。

> 开发/测试基线：仓库 `devDependencies` 里的 `@deepseek-ai/dsh-tools`、`dsh-host-webserver` 固定在 `0.2.1-alpha.2`（单元测试不依赖 DSH 运行时版本，通过 shim 注入）；运行环境已实测到 `0.2.1-rc.2`。`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 保留库级区间（`^4.0.1 || ^4.0.5-alpha.1` 等）——它们不是 DSH 版本声明，DSH 的门禁也只校验 `@deepseek-ai/dsh*`。

## 使用方法

前置：Node ≥ 22.3、DSH ≥ 0.2.1-alpha.2（详见上文「兼容性」）。

### 方式一：从源码构建后安装（推荐自用 / 需要改代码）

```bash
git clone https://gitee.com/<account>/dsh-db-manager.git      # 或下载源码压缩包解压
cd dsh-db-manager
npm install
npm run build                          # 受限环境（DSH 沙箱）改用：node scripts/build-sandbox.mjs
dsh plugin --profile web add .         # 把构建产物装进 web profile（内部转发 pnpm add）
```

- `dsh plugin --profile <name> add <目录|包名>` 只负责**把插件装进 profile**，**不会替你构建**；`lib/` 必须先由上一步生成，否则 DSH 启动时找不到 `lib/index.js`。
- 装完确认 profile 的 `cordis.patch.yml` 含本插件的 `insert` 块（把包内 `cordis.patch.yml` 的 insert 段复制过去；市场安装会自动应用）。
- 然后**重启 DSH**，刷新页面 → 设置 → 数据库。

### 方式二：按 DSH 版本选插件版本

DSH 换代快，每个 Release 正文都会写明「声明支持 + 实测过」的 DSH 版本（规则见[开发规范 §7.2](docs/开发规范.md)）。先看自己的 DSH 版本，再挑对应的插件版本：

| 你的 DSH | 装哪个插件版本 |
|---|---|
| 0.2.1 线（实测 `0.2.1-alpha.2`、`0.2.1-rc.2`） | 最新的 0.2.1 线 Release |
| 0.1.x / 0.2.0 | 不支持（已移除声明，安装会被版本门禁拒绝） |

```bash
dsh plugin --profile web add dsh-db-manager@<version>     # npm 已发布时：装指定版本
# 源码方式装指定版本：
git checkout v<version> && npm install && npm run build && dsh plugin --profile web add .
```

### 方式三：市场一键安装（收录后）

设置 → 插件市场 → 搜索 `db-manager` → 一键安装（自动应用 `cordis.patch.yml`，无需手改补丁）。

### 首次配置

1. 设置 → 数据库 → **新建连接**：选方言（MySQL / PostgreSQL / SQLite），填地址与库名；SQLite 填 `.db` 文件路径（须位于当前项目目录内，或使用 `:memory:`）。
2. 密码填 `$ENV:VAR_NAME` 或 `enc:v1:` 密文（终端运行 `node bin/encrypt.js` 生成），**不要填明文**——明文会被校验层直接拒绝。
3. 保存后点「测试」，连通后再点「查看表」。
4. 回到对话说「用 xxx 库查最近 10 条订单」，模型会调用 `db_*` 工具。

完整配置项与协议细节见[需求设计文档](docs/需求设计文档.md)（附录 B 为配置速查）。

### 更新与卸载

```bash
dsh plugin --profile web add dsh-db-manager@latest    # 更新到最新版
dsh plugin --profile web remove dsh-db-manager        # 卸载（再删掉 cordis.patch.yml 里的 insert 块）
```

## 安全与使用边界

**凭据怎么存**：配置文件里的密码只有两种合法形态——`$ENV:VAR_NAME` 环境变量引用，或 `enc:v1:<iv>:<tag>:<cipher>` 密文（AES-256-GCM，12 字节随机 IV、16 字节认证标签、base64url 编码）。明文写进配置会被校验层直接拒绝。密钥是 `$DSH_HOME/db-manager/secret.key`（默认 `~/.dsh/db-manager/secret.key`）里的 32 字节随机值，首次使用时生成、权限 `0600`；密文可在终端用 `node bin/encrypt.js` 离线生成，明文不经过模型上下文。SSH 私钥与口令、跳板机密码同规则处理。凭据不进审计日志、不进工具返回、不在 GUI 回显（界面只显示「已配置机密」与来源）。

**这条边界的另一半**：密钥与配置文件都在本机，**能读到它们的人就能解开密码**——本插件不接系统钥匙串、不做二次口令保护（有意不引入该依赖）。多用户机器或共享账号请自行收紧目录权限。

**无遥测**：不收集、不上报任何使用数据。Host 半区只连接两类目标——你配置的数据库与你配置的 SSH 跳板机；浏览器半区唯一的网络请求是同源的 `/db-manager/api/*`（本机 DSH 服务）。审计日志只写本地：`$DSH_HOME/db-manager/audit/YYYY-MM-DD.jsonl`，按天滚动、凭据打码。

**能力边界**：默认只读；SQL 安全网关用 AST 分类 + 规则层拦截多语句与高危语句；写执行（UPDATE/DELETE）前按策略把受影响行影子备份到同库备份表，高危语句需宿主人工审批或 HMAC 确认令牌；「查看表」只读元数据、不触碰数据行；项目私有连接的写入受路径白名单约束，白名单外 fail-closed 拒绝。

**危险操作提醒**：`db_execute` 具备写库能力——**不要拿未经审核的 SQL 打生产库**，执行前确认目标连接、先做备份；SSH 隧道只绑 `127.0.0.1`，跳板机主机密钥严格校验（`known_hosts` 中没有的需先手工 `ssh` 登录一次）。本软件按 MIT「按原样」提供，不附带任何担保，详见 [LICENSE](LICENSE)。

## 许可

MIT，全文见 [LICENSE](LICENSE)。可自由使用、修改、分发与商用，保留版权与许可声明即可。所依赖的第三方组件（mysql2 / pg / zod / ssh2 / node-sql-parser）的许可与版权行见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

**名称与标识**：欢迎 fork、修改与再分发，但不得使用本项目名称「dsh-db-manager」或其标识暗示与本项目或作者的官方关联、赞助或背书；衍生分发请改用你自己的名称。
