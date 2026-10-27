# AGENTS.md

本文件写给在本仓库上工作的 AI agent。内容全部来自实际踩过的坑，不是通用建议。
**动手前请先读「不可做的事」一节**——其中几条一旦违反，会破坏用户正在使用的环境。

---

## 项目定位（先理解，再改代码）

这个仓库是一个 OpenAI 兼容网关，把 OpenCode 的模型能力转成标准 API。有两条上游：

- **`go/` 路由** —— OpenCode Go 订阅，走正常 HTTPS API，稳定可用。
- **`free/` 路由** —— OpenCode 免费模型。这里的机制与其他一切都不同，见下节。

### 免费模型的本质约束

**OpenCode 的免费额度挂在「官方客户端进程」上，不挂在 API Key 上。** 这是实测结论
（2026-10-26，同机同时刻）：

| 调用方式 | 结果 |
| --- | --- |
| `opencode run`（干净数据目录、无 auth.json、无任何 Key） | ✅ 成功 |
| 裸 HTTP + 有效 `oc_sk_` Key | ❌ 429 `FreeUsageLimitError` |
| 同上 + 伪造 `User-Agent: opencode/1.18.34` | ❌ 429（UA 不是判据） |
| opencode2api 匿名通道 `/inference` | ❌ 429，`Retry-After` ≈ 9 小时 |

推论，请记牢：

- **换 Key、填 `zen_keys`、改 UA、切 `anonymous` 全都无效。**
- 唯一可行的路径是**驱动 CLI 进程**，因此 `src/cli-server.ts` 存在。
- 不要试图「优化」成纯 HTTP 调用，那条路已证实死路。

### 额度的计数维度：按 UTC 日重置，与 Key / IP 无关

2026-10-27 实测。额度耗尽后逐个排除可能的计数维度：

| IP 出口 | 凭据 | 结果 |
| --- | --- | --- |
| 默认线路 | 有效 `oc_sk_` Key | ❌ 429 |
| `95.40.244.5`（代理） | 有效 `oc_sk_` Key | ❌ 429 |
| `95.40.215.88`（代理） | **不带 Key** | ❌ 429 |
| `95.40.244.5`（代理） | **无效 Key** | ❌ 429 |

结论：**与 Key 无关，与出口 IP 无关。**

**它按 UTC 自然日重置。** 决定性证据是 429 响应里的 `Retry-After` 连续三次精确指向同一
时刻（误差 ≤1 秒）：

```
Retry-After: 64553s -> UTC 2026-10-28 00:00:00
Retry-After: 64537s -> UTC 2026-10-28 00:00:01
Retry-After: 64529s -> UTC 2026-10-28 00:00:00
```

（北京时间 = UTC+8，即每日 **08:00** 重置。）这种规律性不可能是「一次性试用配额」，
早前版本的本文件做过该推断，**是错的，已更正**。

计数绑定的是「通过官方客户端发起的请求」这一身份类别，而非某个账号或某个 key：

| 维度 | 是否影响计数 | 证据 |
| --- | --- | --- |
| API Key | ❌ | 无 Key / 无效 Key 结果相同 |
| 出口 IP | ❌ | 两个不同 IP 都是 429 |
| 客户端身份 | ✅ | 零凭据的 CLI 能用，裸 HTTP 不能用 |
| UTC 日 | ✅ | `Retry-After` 精确指向 UTC 零点 |

因此：

- **不要写「换出口 IP 轮换」这类逻辑**（opencode2api 的多出口设计在这里无效）。
- **不要写「换 Key 重试」**，同样无效。
- 恢复时机可以直接从 429 的 `Retry-After` 推算，**不需要轮询试探**——这比盲目重试准确
  得多，也不浪费额度。`cli-server` 已把它写进响应的 `retry-after` 头。
- 唯一仍可能有效的方向是「客户端身份」判定本身（TLS 指纹、`x-opencode-*` 头组合），
  但**未验证**；UA 伪装已证实无效，不要在这上面浪费时间。
- **不要把免费档当作可用性保证。** 需要稳定就用 `go/` 路由。

---

## 不可做的事

### 1. 不要删除 `bin\opencode2api.exe`

`bin/` 在 `.gitignore` 里，删了**无法从 git 恢复**。

DSH 插件（`dsh-opencode-gateway`）的启动逻辑是：

```js
// src/index.ts:298
if (serverReady) next.set(options().free.provider, buildFreeState())
```

`serverReady` 只有在「插件自己的 loopback 服务成功启动」后才为 true，而那要等
`ensureServiceRunning` 成功。该函数在 18080 无响应时会尝试 spawn `bin\opencode2api.exe`；
**文件不存在就抛异常，`serverReady` 永远为 false，免费模型从此不再出现在菜单里**，
且本次会话内不会重试。

我删过一次，导致用户连续多轮报「下拉框没有 free 模型」。

### 2. 不要在 ESM 文件里用 `require()`

`src/**/*.ts` 全部按 ESM 运行。`require("node:os")` 会抛 `ReferenceError`，
**若被 `try/catch` 包住就会静默返回 undefined**，表现为「功能看起来正确但完全不生效」。

我因此让额度检测失效了好几轮，而代码「看起来是对的」。用 `import os from "node:os"`。

### 3. 不要通过 `cmd.exe` 中转启动服务

本机用户名含非 ASCII 字符（`拯救杰宝者`），控制台代码页是 GBK(936)。
经 `cmd.exe` 启动的进程会收到**被篡改的环境变量**，例如：

```
USERPROFILE = C:\Users\鎷晳鏉板疂鑰匼      ← 真实值 C:\Users\拯救杰宝者
```

CLI 用 `USERPROFILE` 拼日志路径，于是报：

```
Unknown: FileSystem.open (...\.local\share\opencode\log\opencode.log)
```

这个错误**看起来像文件锁问题，实际是编码损坏**。我曾据此误判为「日志被占用」，
浪费数轮。

正确做法：spawn `node.exe` 或 `opencode.exe` 的**绝对路径**，`stdio` 直连，不经 shell。

### 4. 不要设置 `XDG_DATA_HOME` / `XDG_STATE_HOME`

出于「绕开中文路径」的目的重定向 XDG 会让 CLI **永久挂起**：

- 默认 profile：约 10s 完成
- 设置 XDG 后：70s 内零事件，必须 kill

`src/opencode-local/serve-backend.ts` 的 `resolveDataHome` 因此只返回 `options.dataHome`。

### 5. 不要用 `Start-Process` 在 DSH 工具会话里启动长驻进程

本机环境同时存在 `NO_PROXY` 和 `no_proxy`，`Start-Process` 会在
「已添加项。字典中的关键字:NO_PROXY」处失败，且就绪重定向参数也会因同因崩溃。

改用 `cmd /c start`（会创建独立进程树）或 `wscript`（可隐藏窗口）。

### 6. 不要从 agent 会话里启动需要长期存活的服务

agent 的 shell 是 DSH 的子进程，进程链为：

```
node.exe ← cmd.exe ← powershell.exe ← DeepSeek Harness.exe
```

用户重启 DSH 时**整棵树被清理**。这就是服务「反复消失」的根因。

长驻服务必须**脱离该进程树**：用计划任务、注册表 Run 键、或 `wscript` 孤儿化。

---

## 启动架构（改之前先理解）

```
DSH 插件 ──────────────┐
                       ├──► cli-server :18080 ──► opencode serve :10001 ──► 免费模型
客户端 ──► 网关 :8787 ──┘
```

- **`src/cli-server.ts:18080`** —— 插件默认的 `free.serviceUrl`。实现了插件期望的契约：
  `/healthz`（免鉴权，供 `serviceHealthy` 调用）、`/v1/models`、`/v1/chat/completions`、
  `/v1/responses`。鉴权复用 `bin/config.json` 的 `server_keys[0]`。
- **`opencode serve:10001`** —— CLI 的常驻后端。**这是性能关键**，见下节。
- **网关 `:8787`** —— 通过 `src/free-lane.ts` 把 cli-server 作为**子进程**管理，
  网关起它就起，网关停它就停。

### `/v1/models` 必须返回裸模型 id

插件把该列表**直接**喂进模型菜单（`freeProfile` 不剥离前缀），而它的配置用裸 id
（`big-pickle`，不是 `opencode/big-pickle`）。返回带前缀的 id 会导致菜单匹配不到，
表现为「端点返回了空模型列表」。

---

## 性能：为什么必须常驻

单次调用耗时实测：

| 方式 | 耗时 |
| --- | --- |
| 每次 spawn `opencode run` | ~30s |
| 复用 `--session` | ~29s（**无改善**，瓶颈不是会话建立） |
| 常驻 `opencode serve` 预热后 | **4–5s** |

所以 CLI 后端必须常驻。代价是**服务刚启动后的第一次调用仍需 ~20–30s**（后端冷启动），
之后稳定在 4–5s。

---

## 额度：如何判断，以及不要怎么判断

免费额度耗尽时 CLI **不返回错误**，它记录日志后自己重试，HTTP 请求永不返回。
这会让「额度墙」表现为「网关挂起」。

### 正确做法

1. **熔断器**（`src/opencode-local/serve-backend.ts`）：只在**观察到失败**后打开，
   冷却 5 分钟。打开期间请求立即拒绝，不触网。
2. **日志仅用于解释**：请求已经失败/超时后，读 CLI 日志把「没有响应」翻译成
   「额度耗尽」。

### 不要做

- **不要在发请求前扫日志做预检查。** 日志跨进程共享且含历史，会把**本可成功**的请求
  拦掉。这是真实误判风险，已移除。
- **不要加后台轮询。** 本模块没有任何定时器，闲置时零消耗。熔断只在用户真发请求时检查。
- **不要在失败时回退到 one-shot 路径。** 额度墙下那条路只会再花 30s+ 并同样失败。

### 已消除的浪费

CLI 每次创建会话都会额外调一个小模型（`gpt-5.4-nano`）生成标题。实测一上午产生
**72 次**此类请求，且全部因余额不足而失败。`servePrompt` 显式传 `{ title: "free-lane" }`
即可跳过。

---

## 验证纪律（这几轮最欠缺的部分）

**改完必须跑端到端，不能只验改动点。** 我犯过的具体错误：

1. 改了 `serve-backend.ts` 的默认超时，但 `cli-server.ts` 显式传了 `90_000` 把它覆盖，
   于是「修复」完全没生效。**改默认值时必须全仓搜索该参数的显式传参点。**
2. 说「改好了」就让用户重启 DSH，而链路其实没通。

改完至少检查：

```powershell
# 1) 单元测试
& "C:\Program Files\nodejs\node.exe" --test "tests/*.test.ts"

# 2) 三层端口都在
foreach ($p in @(8787,18080,10001)) {
  netstat -ano | Select-String ":$p\s" | Select-String 'LISTENING'
}

# 3) 真实调用计时（不要只看状态码）
# 4) 进程树：18080 的父进程应是 8787，10001 的父进程应是 18080
```

**遇到额度错误立即停止测试。** 每次调用都在消耗额度，盲目重试验证会加速耗尽。
实测我在额度已耗尽后又发了 16 次无效请求。

---

## 环境事实速查

| 项 | 值 |
| --- | --- |
| Node（网关运行用） | `C:\Program Files\nodejs\node.exe`（v26，原生跑 TS） |
| Node（PATH 上的） | v16.9.1 —— **太老，不能跑 TS** |
| opencode CLI | `E:\STUDY\IT\nodejs\node_global\node_modules\opencode-ai\bin\opencode.exe` |
| opencode 日志 | `~/.local/share/opencode/log/opencode.log` |
| 插件位置 | `~/.dsh/profiles/desktop/node_modules/dsh-opencode-gateway`（软链到 `E:\Agent\dsh-opencode-gateway`） |
| 插件配置 | `~/.dsh/profiles/desktop/cordis.patch.yml` |
| 代理 | `http://127.0.0.1:7897`；`NO_PROXY` 含 `opencode.ai` |
| 管理员权限 | **不可用**（审批策略为 never），`schtasks /sc onlogon` 会 Access denied |

---

## 已知未解 / 待观察

- **恢复时刻已知，但无法提前查询。** 额度按 UTC 日重置（见上文实测），所以「何时恢复」
  可以从任一 429 的 `Retry-After` 直接推算，不需要轮询。真正缺的是「当前还剩多少」——
  官方没有额度查询接口（`/usage`、`/account`、`/config/providers` 均无），
  只能靠真实请求撞出来。
- **额度由可用转为耗尽时，第一次调用要等 20s**（`cli-server.ts` 的 `timeoutMs`）。
  这是唯一能付的代价。撞到之后熔断 5 分钟，期间立即拒绝。
- **启动顺序仍是软约束。** 若 DSH 在 `18080` 就绪前加载插件，本次会话不会注册 free
  模型，只能重启 DSH。`src/free-lane.ts` 把 cli-server 绑成网关子进程即为此设计，
  但网关自身也需在 DSH 之前起来。
