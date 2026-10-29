# dsh-db-manager 变更记录 v0.16（SSH 隧道连接 / FR-13）

**变更日期**: 2026-10-10
**前置版本**: v0.15
**本文定位**: 实现 PRD 中原列 P2 的 FR-13——数据库只允许从跳板机访问时，先建 SSH 隧道再连数据库。上一区间见 [CHANGELOG-v0.15-项目视图与性能优化.md](./CHANGELOG-v0.15-项目视图与性能优化.md)。

## 一句话总览

| 项 | 类型 | 主题 | 用户感知 |
|----|------|------|---------|
| 新功能 | feature | SSH 隧道 | 连接可引用可复用的 SSH 配置；连库时先连跳板机、再经隧道连数据库 |
| 新功能 | feature | SSH 配置管理 | 设置页新增「SSH 配置」标签页（增删改）；连接编辑器下拉选用 |
| 安全 | security | 严格主机密钥校验 | 服务器公钥必须已在 known_hosts 中，否则拒连（无首次信任、无跳过开关） |
| 安全 | security | 凭据同规则落盘 | SSH 密码/私钥/口令仅允许 `$ENV:VAR` 或 `enc:v1` 密文，页面永不回显 |
| 依赖 | chore | 新增 `ssh2` | 纯 JS 实现；已验证不引入原生编译工具链 |

## 一、为什么是进程内 `ssh2`，而不是调用系统 `ssh`

| 方案 | 结论 |
|------|------|
| 调用系统 `ssh -L`（spawn 子进程） | ✗ 隧道生命周期要与**连接池条目**绑定（随池关闭），子进程难以精确管理；密码/内联私钥认证无法通过 `ssh` 二进制驱动；需要临时密钥文件；依赖系统 OpenSSH 版本（本机为 8.1p1，较旧） |
| **进程内 `ssh2`（选用）** | ✓ 隧道与池条目同生命周期；支持 密码 / 私钥文件 / 内联 PEM / ssh-agent 四种认证；无子进程、无临时文件、无 shell 参数面；可做严格主机密钥校验；跨平台一致 |

**依赖影响（已实测）**：`npm install ssh2` 在本机 exit 0、未引入 `node-gyp`/`prebuild-install` 等编译工具链。`ssh2` 的运行依赖为纯 JS（`asn1`/`bcrypt-pbkdf`），其 `cpu-features` + `nan` 是**可选**加速包——缺失时 ssh2 仍正常工作，安装失败不会中断 `npm install`。已据此更新《开发规范》§1 依赖白名单。

## 二、配置结构（可复用 SSH 配置 + 连接引用）

按用户确认的方案：SSH 配置**独立定义、可被多条连接复用**（同一跳板机下多个库无需重复填写）。

```jsonc
// ~/.dsh/db-manager/connections.json（或 <项目>/.dsh/db-manager.json）
{
  "sshProfiles": [
    {
      "name": "jump-prod",
      "host": "203.0.113.10",              // 跳板机（必填）
      "port": 22,                       // 默认 22
      "username": "deploy",             // 必填
      "auth": {
        "method": "keyfile",            // agent | keyfile | key | password
        "keyPath": "~/.ssh/id_rsa",     // method=keyfile（支持 ~）
        "passphrase": "$ENV:SSH_PASS",  // 可选，密钥口令
        "privateKey": "enc:v1:…",       // method=key（内联 PEM）
        "password": "$ENV:SSH_PW"       // method=password
      },
      "knownHostsPath": "~/.ssh/known_hosts",  // 可选，默认该路径
      "readyTimeoutMs": 20000,          // 可选
      "keepaliveIntervalMs": 10000      // 可选
    }
  ],
  "connections": [
    { "name": "pg-general", "dialect": "postgresql", "host": "198.51.100.20", "port": 5432,
      "username": "app", "password": "$ENV:PG_PW", "sshProfile": "jump-prod" }
  ]
}
```

> 本文所有示例地址均取自 **RFC 5737 文档专用网段**（`203.0.113.0/24`、`198.51.100.0/24`）、示例账号为 `deploy`/`app` 等通用值，不代表任何真实环境。

- **引用语义**：`connections[].sshProfile` 指向同名 SSH 配置。查找顺序为**工作区配置优先、全局兜底**（与连接的同名覆盖语义一致）。
- **解析失败即拒连**：引用了不存在的 SSH 配置 → 直接返回配置错误（fail-closed），**绝不回退为直连**。
- **SQLite 不参与**：`sshProfile` 只存在于 MySQL/PostgreSQL 的 schema 中（本地文件无远端）。

## 三、隧道实现（`src/db/ssh-tunnel.ts`）

```
驱动 ──▶ 127.0.0.1:<随机端口>（本地转发，仅绑定回环） ──SSH──▶ 跳板机 ──▶ 数据库 host:port
```

关键点：

1. **本地转发只绑 `127.0.0.1`**，绝不暴露到局域网。
2. **隧道随池条目生命周期**：`PoolManager` 的缓存条目从「driver」变为「driver + tunnel」；规格变更（改 host/密码/**SSH 配置**）触发剪枝时会先关隧道再关驱动；`close`/`closeAll`/`retainOnly` 同样级联关闭。
3. **SSH 配置参与缓存指纹**：跳板机 host/port/用户名/认证方式/密钥路径/全部机密与 known_hosts 路径都进入指纹——改任一项都会重建隧道与驱动（不会复用旧隧道）。
4. **连通性测试同样走隧道**：`probeConnection` 自建隧道并在 `close()` 中一并关闭，因此 GUI「测试」按钮与 `db_test_connection` 验证的正是真实数据路径；批量测试对每条连接单独报告 SSH 配置错误而不中断整轮。
5. **错误归类**：SSH 失败映射到既有 `DbErrorKind`（`auth`/`network`/`timeout`/`config`），并附带可操作 `hint`（如「先手动 ssh 一次以写入 known_hosts」）。

## 四、安全设计

### 4.1 主机密钥：严格校验（按用户选择）

- 实现 `verifyHostKeyAgainstKnownHosts()` 纯函数，兼容 OpenSSH 语义：
  - 默认端口用 `host` 条目；**非 22 端口要求 `[host]:port` 条目**；
  - 支持**哈希条目** `|1|salt|hash`（HMAC-SHA1 校验）；
  - 支持逗号分隔多主机名、注释与空行；
  - `@revoked` 直接拒绝；
  - 同 host 但密钥不一致 → 明确提示「可能被更换或存在中间人攻击」。
- **无首次信任（TOFU）、无「跳过校验」开关**：未在 known_hosts 中的主机一律拒连。
- known_hosts 文件不可读 → 配置错误并说明如何处理。

### 4.2 凭据

- SSH 密码 / 私钥内容 / 口令与数据库密码**同规则**：schema 层拒绝明文，只接受 `$ENV:VAR` 或 `enc:v1:` 密文；GUI 输入明文由 Host 端**即时加密**后落盘。
- GUI 列表只返回 `hasPassword`/`hasPrivateKey`/`hasPassphrase` 布尔标记，**永不回显任何机密**。
- 私钥文件路径（`keyPath`）不是机密，按原样展示与存储。
- ssh-agent 认证不落任何凭据（Windows 走 `\\.\pipe\openssh-ssh-agent`，POSIX 走 `SSH_AUTH_SOCK`）。

### 4.3 写入面

- `sshProfiles.save` / `sshProfiles.delete` 复用与连接相同的写入层：损坏文件拒写（M5）、原子写（tmp + rename）、缓存失效、审计留痕。
- 工作区目标的 `workspace` 参数沿用 **fail-closed 路径白名单**（只能操作插件观察到的项目）。

## 五、GUI

新增第三个标签页「**SSH 配置**」：

- 列表：名称、`user@host:port`、认证方式徽章、已配置机密（仅在 / 口令 / 密码 的**存在标记**）、私钥路径、known_hosts 路径；
- 表单：名称 / 跳板机 host / 端口 / 用户名 / 认证方式（私钥文件、ssh-agent、私钥内容、密码）/ 私钥路径 / 三个机密字段（各带「保持不变 / $ENV / 明文即时加密 / enc 密文」四种方式）/ known_hosts 路径；
- 连接编辑器新增「**SSH 跳板机（可选）**」下拉：全局 SSH 配置 + （项目连接时）该项目自己的 SSH 配置；选「不使用」即清除隧道。

## 六、RPC 协议（新增）

| 方法 | 入参 | 说明 |
|------|------|------|
| `connections.list`（扩展） | — | 响应新增 `sshProfiles: [{ name, scope, host, port, username, authMethod, keyPath?, hasPrivateKey, hasPassphrase, hasPassword, knownHostsPath? }]`；连接项新增 `sshProfile?` |
| `sshProfiles.save` | `{ originalName?, workspace?, profile }` | 写入全局或项目配置；机密按 `{ mode, plain?, env?, enc? }` 解析；同名默认拒绝 |
| `sshProfiles.delete` | `{ name, workspace? }` | 删除；`workspace` 受白名单约束 |
| `workspaces.list`（扩展） | — | 每个项目新增 `sshProfiles`（该项目声明的 SSH 配置） |
| `connections.test`（扩展） | `{ name, workspace? }` | 指定 workspace 时测试项目连接（含其 SSH 隧道） |

工具侧：`db_add_connection` 新增 `sshProfile` 参数；`db_list_connections` 返回 `sshProfile` 字段。

## 七、顺带修复的既有安全缺口：`localInfile` 安全钉无效

在真实库穿透验证时（见 §9），运行日志出现 mysql2 的警告：

```
Ignoring invalid configuration option passed to Connection: localInfile
```

追查结论（**已实证，非推测**）：

| 事实 | 证据 |
|------|------|
| mysql2 3.24.4 **没有** `localInfile` 这个连接选项 | 连接时打印上述警告；`node_modules/mysql2` 中不存在该选项的读取点 |
| mysql2 默认**开启** `LOCAL_FILES` 客户端能力位（`0x80`） | `new ConnectionConfig({host,user}).clientFlags & 0x80 !== 0` → true |
| `flags: '-LOCAL_FILES'` 才真正清除该能力位 | `new ConnectionConfig({...,flags:['-LOCAL_FILES']}).clientFlags & 0x80` → 0 |
| `extraParams.flags` 是**真实注入路径** | `flags:['LOCAL_FILES']` 让能力位重新变成 1——原始 denylist 只禁了 `localInfile` 而漏了 `flags` |

即：原代码里 `localInfile: false` 是一行**看起来在防护、实际被忽略**的代码；而 `flags` 这条同样能开关能力位的路径没有设防（`MULTIPLE_STATEMENTS` 同理——单语句安全网关依赖驱动本身拒绝多语句）。

**修复**（三层）：

1. `src/db/mysql-driver.ts`：`localInfile: false` → `flags: ['-LOCAL_FILES']`，并注释说明为何不能用前者（附实测证据）；
2. `src/db/mysql-driver.ts` 的 `FORBIDDEN_MYSQL_KEYS` 加入 `flags`；
3. `src/config/schema.ts` 的 `FORBIDDEN_EXTRA_PARAMS` 加入 `flags`（配置层直接拒绝）。

**测试**（新增 4 例 + 修正 1 例既有断言）：

- 断言产物用 `flags: ['-LOCAL_FILES']` 且**不再**出现 `localInfile`；
- **行为性验证**：用 mysql2 的 `ConnectionConfig` 计算 `clientFlags`，断言 `LOCAL_FILES` 位为 0（同时验证未加钉时为 1，证明该断言有区分度）；
- schema 拒绝 `extraParams: { flags: 'LOCAL_FILES,MULTIPLE_STATEMENTS' }`；
- 即便绕过配置层把 `flags` 送到驱动，仍然以我们的钉为准（`timezone` 等无害项照常透传）；
- 修正既有断言（原先断言 `localInfile === false`，即断言了一个无效钉）。

**修复后复测**：真实 MySQL 穿透查询成功且**日志中不再出现该警告**。

> mysql2 自身在未配置 `infileStreamFactory` 时也会拒读本地文件（fail-closed），所以原先并不存在"可读任意本地文件"的直接利用；本次修复消除的是**无效防护 + 能力位可被重新打开**这一潜在缺口。

## 八、测试（新增 `tests/ssh.spec.ts` 30 例 + 能力钉 4 例）

- **严格校验纯函数**（9 例）：命中 / 密钥不一致 / 未知主机 / 非 22 端口需 `[host]:port` / 哈希条目（含异主机不匹配）/ `@revoked` / 多主机名与注释 / 畸形 blob / 密钥类型解析；
- **schema**（4 例）：四种认证方式的必填校验、明文机密被拒、`$ENV`/`enc:v1` 通过；
- **`resolveSecretField`**（3 例）：keep/env/plain（加密）/enc/none 与错误分支；
- **配置写入**（6 例）：创建加密落盘、同名冲突与替换、更新保留机密、切换认证方式清除无关机密、保留无关顶层字段、损坏文件拒写、删除与不存在、校验失败不落盘；
- **`ConfigStore.resolveSshProfile`**（4 例）：全局命中、工作区覆盖、缺失报错（含可用名列表）、无 sshProfile 时无操作；
- **端到端隧道**（4 例，启动**进程内 ssh2 服务端**）：真实握手 + 主机密钥校验 + direct-tcpip 转发 + 数据往返 + 重复 close 安全；known_hosts 缺记录拒连；密钥不一致拒连；known_hosts 文件缺失归类为配置错误。

全套 **208/208**（v0.15 为 174：新增 SSH 30 例 + 能力钉 4 例）。

## 九、文件变更清单

| 类型 | 路径 | 说明 |
|------|------|------|
| 新增 | `src/db/ssh-tunnel.ts` | known_hosts 严格校验纯函数、`openSshTunnel`（本地转发只绑回环）、`SshError`、错误归类 |
| 代码 | `src/shared/types.ts` | `SshAuthMethod` / `SshAuthSpec` / `SshProfileSpec`；`ConnectionSpec.sshProfile` |
| 代码 | `src/config/schema.ts` | `sshProfileSchema`（含各认证方式必填与机密形式校验）；全局/工作区 schema 增加 `sshProfiles`；连接 schema 增加 `sshProfile`；`FORBIDDEN_EXTRA_PARAMS` 加入 `flags` |
| 代码 | `src/config/store.ts` | `resolveSshProfile(load, spec)`（工作区覆盖全局、缺失报错） |
| 代码 | `src/config/mutate.ts` | `resolveSecretField`、`saveSshProfileInto`、`deleteSshProfileFrom` |
| 代码 | `src/db/pool.ts` | `PoolOptions.sshProfile`；缓存条目带隧道；`createEntry` 建隧道并改写 host/port；指纹含 SSH；级联关闭；`probeConnection` 支持隧道 |
| 代码 | `src/tools/metadata.ts` | `openPoolFor` 解析 SSH 并传入（解析失败即配置错误） |
| 代码 | `src/tools/index.ts` | `testConnection` 支持 sshProfile；`db_test_connection`/`db_add_connection`/`db_list_connections` 接入 |
| 代码 | `src/rpc/routes.ts` | `resolveSshFor`、`sshProfileView`、`globalSshProfileViews`、`rawSshProfiles`；`sshProfiles.save/delete`；test/testAll/browse/describe 接入；`workspaces.list` 附带项目 SSH 配置 |
| 代码 | `src/client/api.ts` | `SshProfileView`；`ConnectionListItem.sshProfile`；列表/项目响应增补 |
| 代码 | `src/client/Section.ts` | 「SSH 配置」标签页（列表/表单/删除）、连接编辑器 SSH 下拉、保存体带 sshProfile |
| 测试 | `tests/ssh.spec.ts` | 30 例（含进程内 SSH 服务端的端到端隧道） |
| 代码 | `src/db/mysql-driver.ts` | 安全钉修复：`localInfile: false`（无效）→ `flags: ['-LOCAL_FILES']`；`FORBIDDEN_MYSQL_KEYS` 加入 `flags` |
| 测试 | `tests/hardening.spec.ts` | 能力钉 4 例（含 mysql2 `ConnectionConfig` 行为性断言）+ 修正 1 例既有断言 |
| 依赖 | `package.json` | `dependencies.ssh2`、`devDependencies.@types/ssh2` |
| 文档 | `docs/开发规范.md` | §1 依赖白名单加入 `ssh2` 及可选原生包说明 |
| 文档 | `docs/需求设计文档.md` | FR-13 转已实现；GUI 线框；RPC 协议 |
| 文档 | `docs/PROJECT.md` / `README.md` | 能力与亮点 |
| 文档 | `docs/CHANGELOG-v0.16-SSH隧道.md` | 本文件 |

## 十、运行验证

| 验证层 | 结果 |
|--------|------|
| `tsc --noEmit` | ✅ |
| vitest 全套 | ✅ 208/208（16 spec） |
| `scripts/verify.mjs` | ✅ 59/59 |
| 沙箱构建（语法/注册/渲染） | ✅ `render=(13 createElement calls)` |
| `render-client.mjs` | ✅ |
| 部署产物哈希（client/routes/mutate/schema/store/ssh-tunnel/pool/tools） | ✅ 与工作区一致 |
| `ssh2` 安装 | ✅ exit 0，未引入 node-gyp/prebuild 工具链 |
| 端到端隧道 | ✅ 进程内 SSH 服务端往返验证 |

## 十一、已知边界

1. **仅单跳**：一条连接只能引用一个 SSH 配置，不支持 `ProxyJump` 多级跳板（如需可后续扩展为链式转发）。
2. **不支持交互式键盘验证（keyboard-interactive）**：仅支持 agent / 私钥文件 / 内联私钥 / 密码四种；需要 MFA/密码键盘交互的跳板机不适用。
3. **不读取 `~/.ssh/config`**：`Host` 别名、`ProxyJump`、`IdentityFile` 等系统 ssh 配置不会被解析；请在插件内显式填写（或使用 agent 认证复用已加载密钥）。
4. **主机密钥不支持 `@cert-authority`**：CA 签名的 known_hosts 条目不会被当作可信来源。
5. **隧道按连接+库缓存**：同一连接的不同数据库会各自建立隧道（跳板机侧会看到多条连接）；如需按连接复用可在后续版本引入按名称引用计数。
6. **`db_add_connection` 只能引用已有 SSH 配置**：模型侧暂不提供创建 SSH 配置的工具，需在 GUI「SSH 配置」标签页创建（或手工编辑 JSON）。
