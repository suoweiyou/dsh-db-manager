# dsh-db-manager 变更记录 v0.21.1（SSH 空口令保存 + known_hosts 可执行提示）

**变更日期**: 2026-10-29
**前置版本**: v0.21
**本文定位**: 两处 SSH 阻塞/可用性修复——无口令私钥无法保存、known_hosts 缺失时只报错不给命令；上一区间见 [CHANGELOG-v0.21-复制与分组.md](./CHANGELOG-v0.21-复制与分组.md)。

## 一句话总览

| 项 | 严重度/类型 | 主题 | 用户感知 |
|---|---|---|---|
| B1 | fix / 阻塞 | 口令留空 = 私钥无口令，不再被当成非法输入 | 「添加 SSH 配置」能存进无口令私钥；口令仍可正常填写 |
| B2 | fix / 可用性 | known_hosts 缺记录时直接给出可复制的那一条命令 | 报错下方出现「在 PowerShell 或 cmd 里执行：`ssh -p …`」+ 目标文件 + `ssh-keyscan` 兜底 |

## 正文

### B1 空口令被误判为「环境变量名不合法」，SSH 配置存不进

**问题**：SSH 私钥绝大多数没有口令（`ssh-keygen` 默认空口令），但「添加 SSH 配置」选「私钥文件」后，口令字段留空点保存必然失败，提示 `SSH 私钥口令：环境变量名不合法`，整个配置文件写不进去。

**根因**（三层叠加，缺一不成立）：

1. **页面总是提交口令字段**：`saveSshProfile` 对 `keyfile` / `key` 两种认证方式无条件附带 `passphrase: secret(...)`，而新建编辑器的口令方式默认是 `env`、变量名为空 → 实际提交 `{ mode: 'env', env: '' }`。
2. **Host 把空值当错误**：`resolveSecretField` 在 `mode === 'env'` 时直接拿空串跑环境变量名正则，失败即返回错误，于是整个保存被拒。
3. **没有「无口令」这条路径**：schema 层 `passphrase` 本就是可选的，缺的只是「空输入 ⇒ 不存口令」的语义。

**修复方案**：

- **Host 侧**（`src/config/mutate.ts`）：`resolveSecretField` 把「空值」解释为「该配置没有这一项机密」——`env` / `plain` / `enc` 三种方式的空输入一律返回 `{}`，不再报错。必填性交给紧随其后的 `sshProfileSchema.superRefine` 按认证方式判定，因此缺少私钥/密码时得到的是方法级文案（如「SSH 认证方式 key 必须提供 privateKey」），比原先的通用报错更准确。
- **Client 侧**（`src/client/Section.ts`）：`secret()` 辅助函数在输入为空时改发 `{ mode: 'none' }`（`SecretMode` 增补 `none`，非用户可选模式）。顺带修掉同类隐患：私钥内容或密码留空时也不再伪装成非法的 `$ENV:` 引用。
- **表单文案**：口令字段标签改为「私钥口令（留空表示私钥无口令）」，让「留空」成为显式可理解的选项。
- **编辑既有配置**：口令方式默认 `keep`，保存时原样保留已存口令；显式清空并保存才会清除。

**兼容性**：无配置迁移——旧配置文件（含已存口令的）读取与原样保留行为不变；只是新增了「不写口令」这条合法路径。

### B2 known_hosts 缺记录时只有结论、没有可执行的命令

**问题**：主机密钥严格校验拒绝连接时，报错只有一句「known_hosts 中没有 `host:port` 的记录（严格校验要求先用 ssh 登录一次…）」。用户知道「要 ssh 一次」，但不知道**具体敲什么**——端口不是 22 要加 `-p`、私钥要加 `-i`、非默认 known_hosts 要加 `-o UserKnownHostsFile`，任何一项漏了都白跑一趟；报错里的 `~/.ssh/known_hosts` 在自定义 `knownHostsPath` 时还是错的文件。

**根因**：`verifyHostKeyAgainstKnownHosts` 是纯函数，只负责判定「可信/不可信」，不掌握 username、认证方式与实际 known_hosts 路径，因此无法拼出可执行命令；而唯一的 hint 是写死的一句话。

**修复方案**：

- 新增 `manualSshCommand()`（`src/db/ssh-tunnel.ts`）：按 profile 生成**可直接粘贴**的命令——非 22 端口补 `-p`、`keyfile` 且填了路径补 `-i`（`~` 自动展开、含空格自动加引号）、`knownHostsPath` 不是默认文件时补 `-o UserKnownHostsFile=…`。
- 新增 `knownHostsFixHint()`：输出多行可执行提示——① 说明这是「手动登录一次以写入主机密钥」；② 与该 profile 认证方式匹配的那条 `ssh` 命令；③ **目标文件绝对路径**；④ 按认证方式的补充说明（密码会提示输入密码 / 内联 PEM 无法直接交给 `ssh` / 未填私钥路径时的默认私钥提醒）；⑤ 无人值守环境的 `ssh-keyscan` 兜底（要求先与管理员核对指纹）。主机已记录但**类型缺失**时，`ssh-keyscan` 自动补 `-t <协商到的类型>`。
- `connectSsh()` 的「known_hosts 不可读」与「主机密钥不在 known_hosts」两个失败出口都改用该提示；「无记录」的原因文案同步收敛为 `（严格校验，不接受首次信任；非 22 端口在 known_hosts 中记作 [host]:port）`。
- **GUI**：SSH 卡片的状态行、`建议：…` 行与顶部通知改为 `white-space: pre-wrap`（`建议` 行用等宽字体），多行命令不再被折成一行。

**示例**（配置 `jump-prod → 203.0.113.10:10222`、密码认证，`known_hosts` 用默认文件）：

```
SSH 连接（配置 jump-prod → 203.0.113.10:10222）：known_hosts 中没有 203.0.113.10:10222 的记录（严格校验，不接受首次信任；非 22 端口在 known_hosts 中记作 [203.0.113.10]:10222）
建议：在 PowerShell 或 cmd 里手动登录一次 203.0.113.10:10222（核对指纹后输入 yes，主机密钥即写入 known_hosts）：
  ssh -p 10222 deploy@203.0.113.10
目标文件：C:\Users\<你>\.ssh\known_hosts
（该命令会提示输入跳板机账号的密码）
若无法交互登录（无人值守），可只取公钥——务必先与服务器管理员核对指纹：
  ssh-keyscan -p 10222 203.0.113.10 >> C:\Users\<你>\.ssh\known_hosts
```

私钥认证时第一条命令变为 `ssh -p 10222 -i C:\Users\<你>\.ssh\id_ed25519 deploy@203.0.113.10`；`known_hostsPath` 自定义时两条命令都会带 `-o UserKnownHostsFile=…` / 指向该文件。

## 文件变更清单

- 代码：`src/config/mutate.ts`（`resolveSecretField` 空值语义）、`src/client/Section.ts`（`SecretMode` + `secret()` + 口令标签 + `pre-wrap` 渲染）
- 代码：`src/db/ssh-tunnel.ts`（新增 `manualSshCommand` / `knownHostsFixHint`，两处 known_hosts 失败出口改用之，`connectSsh` 统一 `manualHint()`）
- 测试：`tests/ssh.spec.ts` 新增 7 例（`resolveSecretField` 空值、无口令 keyfile 保存、命令拼装 5 例）
- 文档：本文、`docs/PROJECT.md` 索引行、`docs/需求设计文档.md` FR-13 补充「口令可留空」
- 版本：`package.json` → `0.21.1`

## 运行验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | exit 0，无错误 |
| 单测全量 | `node --import ./scripts/register-vitest-shim.mjs scripts/run-vitest.mjs` | **288/288 通过**（v0.21 基线 281 + 新增 7） |
| 构建 | `node scripts/build-sandbox.mjs` | host `lib/` 63 文件、client `lib/client.js` 82519 B，gate 通过（`apply`/`inject`/13 处 `createElement`） |

## 已知边界（记录在案，非漏洞）

- 口令字段留空只表示「本次不写口令」，不做 `ssh-agent` 或交互式提示兜底——带口令私钥仍需填写口令（`$ENV:` / `enc:v1:` / 直接输入三者任一）。
- 空字符串口令（长度为 0 的 passphrase）与「无口令」等价；OpenSSH 对两者行为一致。
- `ssh-keyscan` 兜底不加校验就写入 known_hosts，因此提示里明确要求先与管理员核对指纹；交互式 `ssh` 登录仍是首选路径。
- 提示里的命令按 **cmd / PowerShell** 语法生成（`-o UserKnownHostsFile=…` 用双引号包裹含空格路径），POSIX shell 同样可用；未针对 fish 等特殊 shell 做适配。
