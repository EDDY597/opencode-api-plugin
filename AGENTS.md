# AGENTS.md

本文件写给在本仓库上工作的 AI agent。内容全部来自实际踩过的坑，不是通用建议。
**动手前请先读「不可做的事」一节**——其中几条一旦违反，会破坏用户正在使用的环境。

---

## 项目定位（先理解，再改代码）

这个仓库是一个 OpenAI 兼容网关，把 OpenCode 的模型能力转成标准 API。有两条上游：

- **`go/` 路由** —— OpenCode Go 订阅，走正常 HTTPS API，稳定可用。
- **`free/` 路由** —— OpenCode 免费模型，经本地 `oc2api`（uTLS）转发，见下节。

### 免费模型的真正门禁：**TLS 指纹**，不是额度、不是 key、不是出口

2026-10-28 09:00 实测（UTC 额度刚重置 1 小时；同一出口 `66.90.98.34`、同一分钟内）：

| 客户端 | 结果 |
| --- | --- |
| **oc2api**（Go + uTLS 复刻 Bun ClientHello） | **200** `OK`，2.1s |
| Node + `User-Agent: opencode/latest/2.1.1/cli` + 完整 header | **429** `retry-after=82749` |
| Node + 默认 UA | **429** `retry-after=82748` |

**决定性细节**：Node 拿到的 `Retry-After` 是 **82749 秒 ≈ 23 小时**，指向*明天*的 UTC 零点。
可额度 1 小时前才恢复、oc2api 立刻就能 200 —— 所以那个 429 **根本不是「额度耗尽」，而是
「指纹被拒」伪装成了额度话术**。

上游判的是 TLS 握手里的 ClientHello，**不是** header、不是 UA、不是 key、不是出口 IP。
参考实现（[zhuweiyou/oc2api](https://github.com/zhuweiyou/oc2api)）自己的实测表：

| 运行时 | 结果 |
| --- | --- |
| Node（undici/OpenSSL） | 429 |
| curl（OpenSSL，h1 与 h2 都试过） | 429 |
| Cloudflare Workers（真实边缘出口） | 429 |
| **Bun（BoringSSL，官方客户端）** | **200** |

推论，请记牢：

- **Node 永远拿不到免费模型。** 不管出口多干净、UA 多正确、key 多有效、等多久。
  这解释了历史上所有「换 Key / 换 IP / 改 UA / 切 anonymous 都无效」的观测——它们
  从来就不是变量。
- **换出口也没用**：Node 在哪个出口都是 429。本文件曾把这个 429 归因为「出口总账被全球
  流量烧穿」，**是错的归因**，已更正。
- **`Retry-After` 不能用来判断「何时恢复」**——指纹拒绝也带这个头。看到 429 先分清是
  哪种客户端发的，再决定要不要等。
- `go/` 路由不受影响：它不走免费层，`zen/go/v1` 对普通 HTTPS 客户端是开放的（实测 200）。

### 免费模型的通道：oc2api（uTLS）> CLI（Bun）> Node（不可用）

| 通道 | 能出网 | 流式 | 工具 | 延迟 | 进程 |
| --- | --- | --- | --- | --- | --- |
| **oc2api**（默认） | ✅ uTLS 伪 Bun | ✅ 真流式 | ✅ 完整 | **1.3–2.9s** | 1 个静态二进制 |
| CLI（`--transport cli`） | ✅ 真 Bun 客户端 | ❌ 缓冲式 | ❌ 丢弃 | 冷启 20–30s / 热 4–5s | 2 个（18080+10001） |
| Node 直连 zen | ❌ 永远 429 | — | — | — | — |

**为什么用 oc2api 而不是 CLI**：不 spawn CLI、支持真流式与工具调用、快一个数量级。
代价：它是第三方二进制，且**做的是复刻官方客户端 TLS 指纹 + 伪装官方提示词/工具集**，
属于绕过「只允许官方客户端」的限制，条款上是灰色地带。是否长期使用由部署者判断。

**网关为什么不直接发 HTTPS 给 zen**：Node 没有 BoringSSL。链路必须是

```
gateway(Node) ──明文 HTTP──► oc2api(:18090) ──uTLS──► zen
```

本地这一跳没有 TLS，所以不受指纹约束；真正的 TLS 由 oc2api 发出。
**这条链路已端到端验证**：网关 `free/glm-5.3-flash-free` → 200 / 1.3s。

**oc2api 必须设 `API_KEY`**：它监听 `0.0.0.0`，且把空 key 当匿名访问。不设等于把这台机器
的免费额度开放给整个局域网。`gateway.config.json` 里 `lanes.oc2api.apiKey` 与
`free-oc2api` 上游的 `apiKey` 必须是同一个值。

### 构建 oc2api 二进制（`bin/` 被 gitignore，不随仓库分发）

```powershell
# 一次性：装 Go 1.24+（https://go.dev/dl/ 的 go<ver>.windows-amd64.zip，解压即用，无需管理员）
$env:GOPROXY = 'https://goproxy.cn,direct'
$env:GOTOOLCHAIN = 'local'
git clone --depth 1 https://github.com/zhuweiyou/oc2api.git E:\Agent\tools\oc2api
& "<go 解压目录>\bin\go.exe" -C E:\Agent\tools\oc2api build -o oc2api.exe ./cmd/oc2api
Copy-Item E:\Agent\tools\oc2api\oc2api.exe .\bin\oc2api.exe
```

换机器、或上游更新后重跑这几行。`OPENCODE_OC2API_PATH` 可指向别的位置。

### 额度的计数维度（历史记录，**已被上节取代**）

下面这张表是 2026-10-27 在「额度耗尽窗口」里做的排除实验。它当时的结论是「与 Key 无关、
与出口 IP 无关」——**但那一整轮观测其实都发生在 Node 客户端上，而 Node 的 429 是指纹拒绝**，
所以这些行测的都是同一件事，不是额度的计数维度。**保留此表只为说明当时的推理链错在哪，
不要再用它推任何结论。**

| IP 出口 | 凭据 | 当时的观测 | 真实含义 |
| --- | --- | --- | --- |
| 默认线路 | 有效 `oc_sk_` Key | ❌ 429 | 指纹拒绝 |
| `95.40.244.5`（代理） | 有效 `oc_sk_` Key | ❌ 429 | 指纹拒绝 |
| `95.40.215.88`（代理） | 不带 Key | ❌ 429 | 指纹拒绝 |
| `95.40.244.5`（代理） | 无效 Key | ❌ 429 | 指纹拒绝 |

**仍然成立的只有一条**：免费层对 key 不敏感——`Bearer public`、有效 `oc_sk_`、无效 key
拿到的结果一模一样。这符合「免费额度不挂在账号上」的说法。

**「按 UTC 日重置」这条仍然可信**，因为它来自 CLI 日志里连续三次精确指向零点的
`Retry-After`（误差 ≤1 秒），而 CLI 是能真正拿到额度的客户端：

```
Retry-After: 64553s -> UTC 2026-10-28 00:00:00
Retry-After: 64537s -> UTC 2026-10-28 00:00:01
Retry-After: 64529s -> UTC 2026-10-28 00:00:00
```

（北京时间 = UTC+8，每日 **08:00** 重置。）但注意上节那条警告：**指纹拒绝也带
`Retry-After`**，所以这个头只能用来推算「额度何时重置」，不能用来证明「刚才那个 429
是额度问题」。

**已经不需要再做的实验**：
- ❌ 「换出口看能不能绕过」——Node 在哪个出口都是 429，与出口无关；
- ❌ 「等 UTC 零点后验证 HTTP 能不能用」——除非那个客户端是 Bun/uTLS，否则必然 429；
- ❌ 「换 key / 改 UA / 改 session id」——都不是变量。

---

## 不可做的事

### 1. 不要删除 `bin\` 下的二进制

`bin/` 在 `.gitignore` 里，删了**无法从 git 恢复**（要么重新构建，要么没了）。

现在 `bin/` 里有两个关键文件：

| 文件 | 少了会怎样 |
| --- | --- |
| `bin\oc2api.exe` | **免费模型全部 429** —— 网关没有 uTLS 出口。`oc2api-lane` 会在启动日志里报 `oc2api binary not found`，把 `lanes.oc2api.enabled` 误判成死配置 |
| `bin\config.json` | cli-server 拿不到 `server_keys`，**18080 对 DSH 插件变 401**，表现是「免费模型在菜单里但一用就报鉴权错」 |

`bin\opencode2api.exe` 曾经也是其中之一（插件在 18080 无响应时自己去 spawn 它），但该文件
在当前部署里**已经不存在**。这没造成问题，因为网关现在总是先起 18080（`lanes.cliServer`）。
**别把它当成「可以依赖的兜底」**：真需要兜底就得重新准备它，而不是假设它还在。

DSH 插件的启动逻辑（`dsh-opencode-gateway` 的 `src/index.ts:298`）：

```js
if (serverReady) next.set(options().free.provider, buildFreeState())
```

`serverReady` 只有在「插件自己的 loopback 服务成功启动」后才为 true，而那要等
`ensureServiceRunning` 成功。18080 若在插件加载时无响应，免费模型就不进菜单，
且本次会话内不会重试。

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
客户端 ──► 网关 :8787 ──┐
                        ├─(free)──► oc2api :18090 ──uTLS──► opencode.ai/zen
DSH 插件 ──► :18080 ────┘

网关 :8787 ──(go)──► opencode.ai/zen/go/v1
```

**三个本地进程，全部由网关 :8787 启动和停止**（`src/standalone.ts`）：

| 端口 | 谁 | 谁启动 | 作用 |
| --- | --- | --- | --- |
| 8787 | `src/standalone.ts` | 手动 / 托盘 / 启动脚本 | 网关本体 |
| **18090** | `bin/oc2api.exe` | **网关 spawn**（`src/oc2api-lane.ts`） | uTLS 出网，真正打到 zen |
| 18080 | `src/cli-server.ts` | **网关 spawn**（`src/free-lane.ts`） | DSH 插件要的契约，转发到 18090 |

配置在 `gateway.config.json` 的 `lanes` 节：

```json
"lanes": {
  "oc2api":    { "enabled": true, "port": 18090, "apiKey": "<必须设置>" },
  "cliServer": { "enabled": true, "port": 18080 }
}
```

**顺序是硬约束**：oc2api 必须先就绪，cliServer 才能转发。`standalone.ts` 里用
`await` 串起来，就是为此。

**进程绑定已验证**（2026-10-28）：网关 pid → 两个子进程的 `ParentProcessId` 都指向它；
`Stop-Process` 网关后，18090 与 18080 一并消失。重启 DSH / 网关不会留下孤儿进程，
也不会出现「端口被上一代实例占着」。

**已验证的链路**：
- 网关 `free/glm-5.3-flash-free` → 200 / 1.3s
- 18080 shim（带 `server_keys[0]`）→ 200 / 2.3–3.0s，模型列表跟随 oc2api（9 个）

### 18080 的 cli-server 是**缓冲式适配器**，不是完整 API

它的结构性限制在代码里，不在传输方式上：`parts` 只取 `type === "text"`（工具调用被丢弃）、
拿到完整回复才发 SSE、多段对话压成一段文本。**DSH 插件走这条路会失去工具调用与真流式。**

要完整能力就**别走 18080**：直接让客户端连网关 8787 的 `free/` 前缀（网关的 `free-oc2api`
上游是纯转发，`chatBody` 原样透传，工具与流式都保留）。18080 存在的唯一理由是插件写死了那个端口。

### `/v1/models` 的两个口径（别搞混）

| 端点 | 格式 | 谁在消费 |
| --- | --- | --- |
| `18080/v1/models` | **裸 id**（`big-pickle`） | DSH 插件按裸 id 匹配菜单，带前缀会匹配不到 |
| `8787/v1/models` | **带前缀**（`free/big-pickle`、`go/…`） | 网关自己的 OpenAI 客户端 |

18080 的列表现在是**动态**的：从 oc2api 的 `/models` 读（60s 缓存），失败时回退到
`free-lane.ts` 里 `--models` 的静态列表。所以上游增删免费模型不需要改代码——除非
oc2api 整个挂掉，那时才需要更新那份静态回退。

---

## 性能：CLI 传输为什么必须常驻（仅 `transport=cli` 适用）

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
3. **凭「上游要求 X 头」就断言本仓库有 bug，却没先读 HEAD 里那段代码。**
   2026-10-27 我测出 `zen/go/v1` 缺 `x-opencode-session` 会返回 `400 MissingSessionID`，
   于是宣称 `go/` 路由一直在丢请求。实际上 `sessionHeader` 对 `opencode-go` 预设默认就是
   `true`，`sessionIdFor()` 用首条消息 sha1 兜底，**旧代码早就在发这个头**。
   修之前先 `git show HEAD:src/gateway.ts | Select-String 关键字` 看一眼，两分钟的事。

**声称「这是 bug」之前，必须先证明「改之前会失败」。** 上面的教训还有一个副产品：
本轮真正新增的只是「`parent_session_id` 参与会话 id」和「非 Go 的 `sessionHeader` 上游补发
`x-opencode-session-id`」，**不是修 bug**。文档里不要把它写成修复。

改完至少检查：

```powershell
# 1) 单元测试（多文件模式在本沙箱里会 spawn EPERM，逐个文件跑）
foreach ($f in @('session-header','retry','handler','converters','params','streams','truncation')) {
  & "C:\Program Files\nodejs\node.exe" "tests\$f.test.ts"
}
# local-backend / cli-backend 会真的拉起 opencode 二进制，跑之前想清楚

# 2) 四个端口都在
foreach ($pt in @(8787,18090,18080)) {
  netstat -ano | Select-String ":$pt\s" | Select-String 'LISTENING'
}

# 3) 真实调用计时（不要只看状态码）
# 4) 进程树：18090 和 18080 的 ParentProcessId 都应指向 8787 的 pid
Get-CimInstance Win32_Process -Filter "ProcessId=<18090的pid>" | Select-Object ProcessId,ParentProcessId,Name

# 5) 停网关后子进程必须消失（进程绑定的回归检查）
Stop-Process -Id <8787的pid> -Force; Start-Sleep 5
foreach ($pt in @(18090,18080)) { netstat -ano | Select-String ":$pt\s" | Select-String LISTENING }
```

**改网关配置后要确认真的读到了。** 用 `OPENCODE_GO_GATEWAY_CONFIG` 指向一份替代配置做实验时，
最容易踩的坑是「文件写了但没生效」：`loadFileConfig()` 会跳过解析失败的文件、继续找下一个候选。
2026-10-28 我因此把一份带 BOM 的测试配置喂进去，进程默默用了**生产配置**、监听 8787 而不是
测试端口。现在 BOM 已被容错（`replace(/^\uFEFF/, "")`），但**换别的原因失败仍会静默回落**。
验证手段：启动日志里的端口 + `netstat`，别信「我改了文件」。

**端到端要打到真上游，不能只用 mock。** mock 能证明「头发出去了」，不能证明「上游认」。
真上游验证脚本：

| 脚本 | 用途 |
| --- | --- |
| `scripts/verify-oc2api-chain.ts` | 网关 → oc2api → zen，断言 200（免费链路主回归） |
| `scripts/verify-free-http-shim.py` | 起临时 18099 实例测 cli-server 的 http 传输 |
| `scripts/verify-go-session.ts` | `go/v1` 的 session 头（需 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`） |
| `scripts/measure-http-latency.ts` | 流式 TTFB vs 总耗时 |

**遇到额度错误立即停止测试。** 每次调用都在消耗额度，盲目重试验证会加速耗尽。
实测我在额度已耗尽后又发了 16 次无效请求。

---

## 环境事实速查

| 项 | 值 |
| --- | --- |
| Node（网关运行用） | `C:\Program Files\nodejs\node.exe`（v26，原生跑 TS） |
| Node（PATH 上的） | v16.9.1 —— **太老，不能跑 TS** |
| Go 工具链（构建 oc2api 用） | `E:\Agent\tools\go-install\go\bin\go.exe`（1.27.3，解压版，未进 PATH） |
| oc2api 源码 / 构建目录 | `E:\Agent\tools\oc2api`；产物在 `bin\oc2api.exe` |
| opencode CLI | `E:\STUDY\IT\nodejs\node_global\node_modules\opencode-ai\bin\opencode.exe`（1.18.34） |
| opencode 日志 | `~/.local/share/opencode/log/opencode.log` |
| 插件位置 | `~/.dsh/profiles/desktop/node_modules/dsh-opencode-gateway`（软链到 `E:\Agent\dsh-opencode-gateway`） |
| 插件配置 | `~/.dsh/profiles/desktop/cordis.patch.yml` |
| 代理 | `http://127.0.0.1:7897`；`NO_PROXY` 含 `opencode.ai` |
| 管理员权限 | **不可用**（审批策略为 never），`schtasks /sc onlogon` 会 Access denied |

---

## 已知未解 / 待观察

- **oc2api 的长期可用性取决于上游是否改指纹。** 它复刻的是 Bun 的 ClientHello
  （JA4 `t13d1713h1`）。上游一旦换 TLS 栈或改判定，oc2api 会在**同一版本**上突然全 429，
  而我们是拿不到源码级预警的。症状：网关 `free/` 全 429 且 `ra` 指向零点，但 `go/` 正常。
  处置：拉上游新版本重建二进制（见「构建 oc2api」），或把 `lanes.oc2api.enabled` 关掉、
  `OPENCODE_CLI_TRANSPORT=cli` 退回 CLI 通道。
- **oc2api 没有队列/限流**。它把请求直通上游；免费层自己的日额度用光后就是 429。
  网关不会自动降级到 `go/`——客户端会看到 429。要不要做自动回退 `go/` 是产品决定，
  目前**没有做**。
- **`beam-free` 单模型地区受限，不代表全部免费模型。** 2026-10-27：`beam-free` → 403
  `RegionError`；同一条链路、同一凭据下 `glm-5.3-flash-free` / `big-pickle` → 429（当时是
  指纹）。查模型可用性必须**逐个试**，不能抽样一个就下结论。
- **额度用量无法提前查询。** 免费层没有额度查询接口（`/usage`、`/account`、
  `/config/providers` 均无），只能靠真实请求撞出来。oc2api 的 `/health` 与 `/ip` 也不含额度。
- **启动顺序仍是软约束。** 若 DSH 在 18080 就绪前加载插件，本次会话不会注册 free
  模型，只能重启 DSH。网关现在会自己拉起 18090 与 18080，但网关本身仍须在 DSH 之前起来。
- **`go/v1` 与免费通道的 403/429 现在没有分开翻译。** `isFatalUpstreamError` 把 401/402/403
  一律当「不可重试」，方向是对的；但 `cli-server` 侧仍把「无响应」笼统说成「额度耗尽」。
  若将来再出现「等一天也没好」的报障，先看 CLI 日志里是 `FreeUsageLimitError`（真额度）
  还是别的，不要默认是额度。
