# dsh-db-manager 变更记录 v0.19（SSH 主机密钥类型：诊断与协商）

**变更日期**: 2026-10-10
**前置版本**: v0.18
**本文定位**: 修复「严格主机密钥校验」在**服务器提供多种主机密钥类型**时的误报与不必要的摩擦，并附本地写入 known_hosts 的标准操作。上一区间见 [CHANGELOG-v0.18-项目连接共用卡片.md](./CHANGELOG-v0.18-项目连接共用卡片.md)。

## 一句话总览

| 项 | 类型 | 说明 |
|----|------|------|
| 诊断修正 | fix | 报错原来把"主机已记录、但密钥类型不同"说成"known_hosts 中没有记录"，误导用户去找"我是不是没登录过" |
| 协商修正 | fix | 连接时**优先协商 known_hosts 已有记录的类型**，同一台多密钥服务器不再因为客户端偏好而选到没有记录的类型 |
| 严格性 | — | 校验逻辑不变：presented key 必须与同类型记录**完全一致**；只改"选哪种类型去谈"，不改"接受什么密钥" |

## 一、现象与实证

> 本文示例地址取自 **RFC 5737 文档专用网段**（`203.0.113.0/24`）、账号用 `deploy` 等通用值；下文的报错文案、日志形态与耗时是真实排查所得的**形态复现**，不代表任何真实主机名或账号。

用户环境的 SSH 配置：`jump-prod` = `deploy@203.0.113.10:2222`，认证方式 password，known_hosts 用默认路径。

点击「测试连接」报：

```
known_hosts 中没有 203.0.113.10:2222 的记录（严格校验要求先用 ssh 登录一次…）
```

但逐项核对后发现该结论是**错的**：

| 事实 | 证据 |
|------|------|
| 本机 known_hosts **已有**该记录 | `ssh-keygen -F "[203.0.113.10]:2222"` → `# Host [203.0.113.10]:2222 found: line 5` |
| 记录类型是 `ecdsa-sha2-nistp256` | 同上，条目主机列为 `[203.0.113.10]:2222` |
| 服务器**同时提供三种**主机密钥 | `ssh-keyscan -p 2222 203.0.113.10` → `ssh-rsa` + `ecdsa-sha2-nistp256` + `ssh-ed25519` |
| ssh2 实际协商到 `ssh-ed25519` | 探针：`ssh2 协商到的类型: ssh-ed25519`（ssh2 的默认偏好把 ed25519 放第一位） |

即：**主机是已知的，只是协商到的密钥类型没有记录**。原实现只在"记录的类型 == presented 类型"时才比较，于是这种情况落到了"没有记录"的兜底文案。

## 二、修复 1：三层诊断，说清到底缺什么

`verifyHostKeyAgainstKnownHosts()` 现在明确区分三种拒绝：

| 情形 | 文案要点 |
|------|---------|
| 主机有记录，且**同类型**但密钥不同 | 「公钥与 known_hosts 中记录不一致（可能被更换或存在中间人攻击）」 |
| 主机有记录，但**类型不同** | 「known_hosts 中 `host:port` 只记录了 `ecdsa-sha2-nistp256` 类型…本次协商到的是 `ssh-ed25519`（同一台服务器通常同时提供多种类型）。可补充记录：`ssh-keyscan -p 2222 203.0.113.10 >> ~/.ssh/known_hosts`」 |
| 主机**完全无记录** | 保留原「先用 ssh 登录一次…非 22 端口需 `[host]:port` 形式」的说明 |

新增纯函数 `recordedHostKeyTypes(knownHostsText, host, port)` 供诊断与协商共用（去重、按 OpenSSH 的 `host` / `[host]:port` / 哈希条目规则匹配）。

## 三、修复 2：优先协商"已有记录的类型"

```ts
algorithms: {
  // ssh2 里这个列表叫 serverHostKey
  serverHostKey: hostKeyAlgorithmsFor(knownHostsText, host, port),
}
```

`hostKeyAlgorithmPreference(recorded)` = **已记录类型在前 + ssh2 标准列表兜底**：

```
ecdsa-sha2-nistp256 → ssh-ed25519 → ecdsa-sha2-nistp384 → …（标准列表）
```

设计取舍：

- **只改顺序，不改校验**：presented key 仍必须与同类型记录完全一致，所以"优先已记录类型"只可能减少摩擦，不可能放宽安全边界；
- **保留完整兜底列表**：若已有记录的类型服务器已不再提供（密钥轮换），握手仍会用其它类型继续，从而得到"公钥不一致"这种**明确**的错误，而不是 `no matching host key format` 这种含糊错误。

### 负向验证（证明该行为真的起作用）

同一场景（服务器提供 ed25519 + rsa，known_hosts 只记录 rsa）：

```
默认顺序(修复前): 协商到 ssh-ed25519 → 无记录 → 拒绝   ← 即用户遇到的报错
已记录优先(修复后): 协商到 ssh-rsa     → 命中记录 → 通过
```

### 真实环境验证

用用户自己的配置直接调用 `probeSshProfile()`：

```
目标: deploy@203.0.113.10:2222
known_hosts 已记录类型: ecdsa-sha2-nistp256
协商顺序(前 3 项): ecdsa-sha2-nistp256 → ssh-ed25519 → ecdsa-sha2-nistp384
✅ 探测成功: 203.0.113.10:2222 延迟 563ms（主机密钥校验 + 认证均通过）
```

结论：**用户的密码本来就是正确的**，此前失败纯粹是密钥类型协商问题；修复后无需任何本地操作。

## 四、附：如何为新跳板机写入 known_hosts

严格校验要求"先信任、后连接"。两种做法：

### 做法 A（推荐）：交互式登录一次

```powershell
ssh -p 2222 <用户名>@203.0.113.10
```

- 首次会提示 `Are you sure you want to continue connecting (yes/no/[fingerprint])?` → 输入 `yes`；
- OpenSSH 会按 `[203.0.113.10]:2222` 形式写入 `%USERPROFILE%\.ssh\known_hosts`（非 22 端口自动加方括号）；
- 若它协商到的类型你已有记录，则**不会提示**，需要时见做法 B。

### 做法 B：只取主机密钥，不登录

```powershell
ssh-keyscan -p 2222 203.0.113.10 2>$null | Where-Object { $_ -notmatch '^#' } |
  Add-Content "$env:USERPROFILE\.ssh\known_hosts"
```

`ssh-keyscan` 会把服务器**提供的所有类型**都写进去（本例是 rsa + ecdsa + ed25519），因此不会再出现"类型对不上"。

> ⚠️ 安全提示：`ssh-keyscan` 属于"信任第一个应答者"，理论上可被中间人利用。若能拿到服务器指纹（`ssh-keygen -lf` 或管理员提供），请先核对；已经信任过该主机的场景风险较低。

### 校验是否写入成功

```powershell
ssh-keygen -F "[203.0.113.10]:2222"     # 找得到即成功
```

### 其他注意点

- 若 SSH 配置里指定了 `knownHostsPath`，要写**那个文件**（插件读的是配置里指定的路径，默认才是 `~/.ssh/known_hosts`）；
- 若 `~/.ssh/config` 里用 `UserKnownHostsFile` 改写路径，交互式 `ssh` 会写那里，而插件默认写 `~/.ssh/known_hosts` —— 请显式配置 `knownHostsPath` 保持一致；
- 写入后**无需重启 DSH**：known_hosts 在每次建连时读取，直接再点「测试连接」即可。

## 五、测试（新增 5 例）

| 用例 | 覆盖 |
|------|------|
| 「类型不匹配」与「无记录」分别诊断 | 断言文案同时包含"只记录了 / 记录类型 / 协商类型 / ssh-keyscan 命令"；同类型不同密钥仍是"不一致"；真未知主机仍报"没有记录" |
| `recordedHostKeyTypes` | 去重、按 `host` vs `[host]:port` 精确匹配、其它主机不串 |
| 顺序与去重 | 已记录类型在前、标准列表完整保留、`ssh-rsa` 必须排在 ssh2 默认首选的 `ssh-ed25519` 之前 |
| 无记录时 | 回落到标准顺序 |
| **多密钥服务器端到端** | 进程内 SSH 服务端同时提供 ed25519 + rsa，known_hosts **只记录 rsa**：隧道必须建立成功且数据往返（去掉偏好该用例会失败，已用负向探针确认） |

全套 **252/252**（v0.18 为 247）。

## 六、文件变更清单

| 类型 | 路径 | 说明 |
|------|------|------|
| 代码 | `src/db/ssh-tunnel.ts` | 拆出 `entryCoversHost`；新增 `recordedHostKeyTypes` / `DEFAULT_HOST_KEY_ALGORITHMS` / `hostKeyAlgorithmPreference` / `hostKeyAlgorithmsFor`；`verifyHostKeyAgainstKnownHosts` 三层诊断；`connectSsh` 传 `algorithms.serverHostKey` |
| 测试 | `tests/ssh.spec.ts` | +5 例（见上表） |
| 文档 | `docs/CHANGELOG-v0.19-SSH主机密钥类型.md` | 本文件 |
| 文档 | `docs/PROJECT.md` | 变更日志索引 |

## 七、验证

| 项 | 结果 |
|----|------|
| `tsc --noEmit` | ✅ |
| vitest 全套 | ✅ 252/252 |
| `scripts/verify.mjs` | ✅ 59/59 |
| 沙箱构建三门禁 | ✅ |
| 真实跳板机探测 | ✅ `deploy@203.0.113.10:2222` 通过（563ms） |
| 负向验证 | ✅ 默认顺序下该场景确实失败 |
| 部署产物哈希 | ✅ 与工作区一致 |

## 八、已知边界

1. **仍不接受"只匹配到别的类型就放行"**：安全模型要求 presented key 与同类型记录完全一致；多密钥服务器靠"优先协商已记录类型"解决，而不是放宽校验。
2. **`DEFAULT_HOST_KEY_ALGORITHMS` 需跟随 ssh2**：该列表镜像 ssh2 的 `DEFAULT_SERVER_HOST_KEY`（当前支持 `ssh-ed25519`/ecdsa 三档/`rsa-sha2-512`/`rsa-sha2-256`/`ssh-rsa`）。升级 ssh2 时若其默认集变化，应同步（多列一个未知算法不会造成危害，服务器会忽略）。
3. **不解析 `~/.ssh/config`**：`Host` 别名、`UserKnownHostsFile`、`ProxyJump` 等仍不读取；需要时在插件里显式填写 `knownHostsPath`。
