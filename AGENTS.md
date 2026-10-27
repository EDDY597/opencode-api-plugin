# AGENTS.md

本文件写给在本仓库上工作的 AI agent。内容全部来自实际踩过的坑，不是通用建议。
**动手前请先读「不可做的事」一节**——其中几条一旦违反，会破坏用户正在使用的环境。

---

## 项目定位（先理解，再改代码）

这个仓库是一个 OpenAI 兼容网关，把 OpenCode 的模型能力转成标准 API。有两条上游：

- **`go/` 路由** —— OpenCode Go 订阅，走正常 HTTPS API，稳定可用。
- **`free/` 路由** —— OpenCode 免费模型。**默认已改回纯 HTTP**（2026-10-27），见下节。

### 免费模型走哪条通道（2026-10-27 起：HTTP 为默认）

`src/cli-server.ts` 现在有两种传输，用 `--transport` / `OPENCODE_CLI_TRANSPORT` 选：

| 传输 | 行为 | 实测 |
| --- | --- | --- |
| **`http`（默认）** | 直接 POST 到 `https://opencode.ai/zen/v1/chat/completions`，`Authorization: Bearer public`，工具/流式由上游决定 | 失败时 **0.3–1.4s** 返回真状态码（429 + `Retry-After`） |
| `cli` | 驱动 `opencode` 二进制（常驻 `opencode serve`，或 one-shot） | 预热后 4–5s；额度耗尽时**挂 20s 再靠日志猜** |

切换：

```powershell
$env:OPENCODE_CLI_TRANSPORT = "cli"   # 回到驱动 CLI
# 或启动参数：node src/cli-server.ts --transport cli
```

**为什么改用 HTTP：** 2026-10-27 复核发现，`glm-5.3-flash-free` / `big-pickle` 用裸 HTTP
一直能到达额度层（1.3s 返回 429），并不是被墙——之前「HTTP 是死路」的判断只测了
`beam-free` 一个模型就推广了，而 `beam-free` 是**单模型**地区受限。原结论已撤回。

**HTTP 传输不做的事（重要）**：只发 `Authorization` + 版本化 `User-Agent` +
`stream: true`，**不伪造 tool 声明、不伪造 session id**。社区 bisect 出的那四条门
（见下文）属于绕过「只允许官方客户端」的限制，这里刻意不实现；如果上游真按那四条
拦，这条通道应当**显式失败**而不是绕过。

### 免费模型的本质约束（原记录，附复核状态）

**OpenCode 的免费额度挂在「官方客户端进程」上，不挂在 API Key 上。** 这是 2026-10-26 的
实测结论：

| 调用方式 | 结果 |
| --- | --- |
| `opencode run`（干净数据目录、无 auth.json、无任何 Key） | ✅ 成功 |
| 裸 HTTP + 有效 `oc_sk_` Key | ❌ 429 `FreeUsageLimitError` |
| 同上 + 伪造 `User-Agent: opencode/1.18.34` | ❌ 429（UA 不是判据） |
| opencode2api 匿名通道 `/inference` | ❌ 429，`Retry-After` ≈ 9 小时 |

推论，请记牢：

- **换 Key、填 `zen_keys`、改 UA、切 `anonymous` 全都无效。**
- **「必须驱动 CLI」这条已不再作为架构前提。** 它只由 10-26 那一次「CLI 成功 / 裸 HTTP 429」
  支撑，而 10-27 复核显示裸 HTTP 只是额度耗尽，两者很可能共用同一个桶。
  现在默认走 HTTP 就是为了用真实使用去证伪它：**重置后第一次调用若 200，说明 HTTP 一直
  可用；若立刻 429，说明是软门禁，那时把 `OPENCODE_CLI_TRANSPORT=cli` 拨回去。**
- 两条通道**共用同一个每日额度**是目前的默认假设，也是上面那个实验要验证的东西。

### 额度的计数维度：按 UTC 日重置；IP 维度**未验证**（本文件早前的「IP 无关」结论已撤回）

2026-10-27 实测。额度耗尽后逐个排除可能的计数维度：

| IP 出口 | 凭据 | 结果 |
| --- | --- | --- |
| 默认线路 | 有效 `oc_sk_` Key | ❌ 429 |
| `95.40.244.5`（代理） | 有效 `oc_sk_` Key | ❌ 429 |
| `95.40.215.88`（代理） | **不带 Key** | ❌ 429 |
| `95.40.244.5`（代理） | **无效 Key** | ❌ 429 |

由此**只能**得出「与 Key 无关」这一条——四行里 Key 出现过有效、无效、缺失三种取值，
结果都是 429，这个结论站得住。

**但「与出口 IP 无关」是错的推断，已撤回。** 那两行代理数据不构成 IP 的对照实验：

1. `95.40.244.5` 与 `95.40.215.88` 是**同一家代理的相邻出口**。若上游按网段或按代理商
   合并计桶，两个 IP 同时是 429 完全正常，并不否定「按 IP 计桶」。
2. 更关键：合上第三、四行其实是**变量没控住**——换了 IP 的同时也换了凭据（无 Key / 无效 Key）。
   一次改两个变量，任何结论都不成立。

那怎么才能证伪？必须是**同一凭据、同一请求形状、只换出口**的 A/B。本机目前做不到：额度正处在
耗尽窗口，两个出口都只会回 429，拿不到可比的 `Retry-After`。**必须等 UTC 零点后立刻做**。

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
| API Key | ❌ | 有效 / 无效 / 缺失三种取值结果相同 |
| 出口 IP | ⚠️ **未验证** | 两个 IP 同属一家代理的相邻出口，且未做「同凭据只换 IP」的对照；早前写的 ❌ 是错的 |
| 客户端身份 | ⚠️ **待复验** | 依据只有 10-26 那次「CLI 成功 / 裸 HTTP 429」；但 10-27 复核显示裸 HTTP 只是额度耗尽，两者可能共用同一个桶 |
| UTC 日 | ✅ | `Retry-After` 精确指向 UTC 零点 |

因此：

- **不要写「换 Key 重试」**，已证无效。
- **出口 IP 轮换：既没有证据支持，也没有证据否定。** 不要把它写成「已证无效」（早前版本
  这么说过，已撤回），但也**不要实现它**——理由是另外两条：额度窗口内测不出来，做完
  也无法验证；而且社区那套 WARP 轮换的做法明确可能违反 OpenCode 条款。要稳定就用 `go/` 路由。
- 恢复时机可以直接从 429 的 `Retry-After` 推算，**不需要轮询试探**——这比盲目重试准确
  得多，也不浪费额度。`cli-server` 已把它写进响应的 `retry-after` 头。
- 「客户端身份」判定确实存在（社区已逐条 bisect 出四个条件，见下节），但**本机现在复现不了**：
  额度耗尽窗口内，任何形状的请求都先撞 429，分不清是形状不对还是没额度。要复现必须等
  UTC 零点后。**不要在本机花时间伪造这些头。**
- **不要把免费档当作可用性保证。** 需要稳定就用 `go/` 路由。

### 三条通道的实际行为（2026-10-27 复测，**含一次自我纠错**）

这一节是**跑出来的**，不是查资料得来的。复现脚本见 `scripts/probe-ip-bucketing.py`。

| 通道 | 请求 | 结果 |
| --- | --- | --- |
| `zen/v1` 免费 **`glm-5.3-flash-free`** | `Bearer public` | **429 `FreeUsageLimitError`**（1.3s 返回，`Retry-After` → UTC 零点） |
| 同上 | `Bearer oc_sk_…`（有效 Key） | **429 `FreeUsageLimitError`**（同上） |
| `zen/v1` 免费 **`big-pickle`** | 两者 | **429 `FreeUsageLimitError`** |
| `zen/v1` 免费 **`beam-free`** | 两者 | `403 RegionError: not available in your country`（**单模型地区限制**） |
| `zen/v1` 付费模型（`gpt-5.4`） | 有效 Key | `403 Model access is disabled`（权限，不是额度） |
| `zen/go/v1`（`deepseek-v4-flash`） | 有效 Key，不带 session 头 | `400 MissingSessionID` |
| `zen/go/v1` | 只带 `x-opencode-session-id` | `400 MissingSessionID`（**名字必须是无后缀的那个**） |
| `zen/go/v1` | 带 `x-opencode-session: <32位sha1>` 或 `ses_…` | ✅ `200`，正常出内容 |

**纠错记录（重要）**：本轮我一度只测了 `beam-free` 一个模型，就把 `403 RegionError`
写成「免费模型在本机被地区封锁」。**那是错的**——`glm-5.3-flash-free` / `big-pickle`
根本不走 geo 拒绝，它们正常到达额度层并返回 429。`beam-free` 那个 403 是**该模型自己**
的地区限制。**测一个模型不能代表一个类别，这是我这几轮第二次犯同类错误。**

因此现在能确定的只有：

1. **`zen/v1` 免费模型的 HTTP 通道没有被墙。** 有额度时它就是通的（1.3s 到额度层）。
2. **`go/v1` 硬性要求 `x-opencode-session`，但不校验它的值。** sha1 和 `ses_` 格式都能过。
   网关只要保证这个头发出去即可，**不需要伪造会话 id**。改名或删掉这个头才会让每条
   Go 请求变成 `400`；「值不像官方格式」不会。
3. **「HTTP 到底是硬门禁还是只是额度耗尽」仍未区分。** 两条 429 的文案完全相同
   （`Free models work in OpenCode... subscribe to OpenCode Go`），所以无法从文案判断。
   判定方法：**UTC 零点（北京 08:00）后第一件事，用同一条裸 HTTP 请求打一次**——
   - 若 `200`：说明 HTTP 一直可用，之前的 429 是**真额度耗尽**，那么「必须驱动 CLI」
     这个架构前提就站不住，CLI 只该作为可选项而不是唯一路径；
   - 若立刻 `429`：说明上游对非官方客户端**恒返回额度耗尽**（软门禁），CLI 才有存在价值。

   这个实验必须在**重置后立刻**做，且只发一次。`scripts/probe-ip-bucketing.py` 可直接用。

### 社区查到的四道门（外部证据，本机无法复现）

来源：[opencode-unlimited-proxy 的 gates 文档](https://github.com/ebouther/opencode-unlimited-proxy/blob/main/docs/free-tier-gates.md)、
[9router #4101](https://github.com/decolua/9router/issues/4101)、
[OmniRoute #16571](https://github.com/diegosouzapw/OmniRoute/issues/16571)。

对方用单变量 bisect 测出，从**能过地区的出口**用匿名 `Bearer public` 直连免费模型时，
要同时满足四条，否则 `403 FreeTierError`：

1. `User-Agent: opencode/<ver>`，**版本 ≥ 1.18.0**（更低是 `426 Upgrade Required`）；
2. `x-opencode-session` 必须**是能被 CLI 的 `Identifier.descending()` 解出近期时间戳**的 id
   （表面正则是 `ses_[0-9a-f]{12}[0-9A-Za-z]{14}`，低 3 位恒为 `ffe`）；
3. tools 里必须有一个**函数名恰好叫 `read`** 的工具（大小写敏感、无前后缀；数量无关；
   发 0 个工具必拒）；
4. 必须 `stream: true`（`stream:false` 直接 403）。

**这些结论对本仓库只有一个实际含义：不要去实现它们。** 第 2、3、4 条是绕过「只允许官方
客户端调用」的限制，属于条款风险区。而且本机目前在额度耗尽窗口，做完也无法验证。
记录在此，是为了下次有人再问「能不能纯 HTTP 调免费模型」时，能直接答「能，但那是绕过门禁，
且要等额度窗口才验证得了」，而不是重新查一遍。

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

默认（`transport=http`，没有 CLI 后端进程）：

```
DSH 插件 ──► cli-server :18080 ──► https://opencode.ai/zen/v1   （直连 HTTPS）
客户端 ──► 网关 :8787 ──┘
```

`transport=cli` 时多一层：

```
DSH 插件 ──► cli-server :18080 ──► opencode serve :10001 ──► 免费模型
客户端 ──► 网关 :8787 ──┘
```

- **`src/cli-server.ts:18080`** —— 插件默认的 `free.serviceUrl`。实现了插件期望的契约：
  `/healthz`（免鉴权，供 `serviceHealthy` 调用）、`/v1/models`、`/v1/chat/completions`、
  `/v1/responses`。鉴权复用 `bin/config.json` 的 `server_keys[0]`。
- **`opencode serve:10001`** —— 仅 `transport=cli` 时存在。
- **网关 `:8787`** —— 通过 `src/free-lane.ts` 把 cli-server 作为**子进程**管理，
  网关起它就起，网关停它就停。**只有 `free` 上游指向本机地址时才会启动它**
  （`standalone.ts` 的 `isLocalUrl` 判断）；指到 `https://…` 时不会白起两个进程。

### 这是一个**缓冲式**适配器，不是完整 API

即便改走 HTTP，经 18080 这条路的**结构性限制仍然存在**，因为限制在 `cli-server.ts`，
不在传输层：

- **没有工具调用**：`parts` 只取 `type === "text"`，工具调用/结果被丢弃（`cli-server.ts` 明确注释）。
- **没有真流式**：拿到完整回复后才一次性发 SSE 帧，TTFB = 总耗时。
- **多轮靠文本拼接**：整段对话压成 transcript，`system` 降级为 `[text]` 段。

要拿回工具和真流式，只能**绕开 18080**：把 `gateway.config.json` 里的 `free-http` 启用
（网关直连 zen/v1，`chatBody` 原样转发，工具透传），代价是 DSH 插件仍然只认 18080，
需要把插件的 `free.serviceUrl` 指到 8787 才行。

### `/v1/models` 必须返回裸模型 id

插件把该列表**直接**喂进模型菜单（`freeProfile` 不剥离前缀），而它的配置用裸 id
（`big-pickle`，不是 `opencode/big-pickle`）。返回带前缀的 id 会导致菜单匹配不到，
表现为「端点返回了空模型列表」。

**注意区分两个端点**：`cli-server:18080/v1/models` 必须给裸 id；
网关 `8787/v1/models` 一律加前缀（`free/xxx`、`go/xxx`），那是给网关自己的 OpenAI 客户端用的，
两者不是同一份列表。DSH 的免费菜单来自 `cordis.patch.yml` 里的静态模型表，不读网关这个端点。

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
# 1) 单元测试（本沙箱里多文件模式会 spawn EPERM，逐个文件跑）
foreach ($f in @('session-header','retry','handler','converters','params','streams','truncation')) {
  & "C:\Program Files\nodejs\node.exe" "tests\$f.test.ts"
}
# local-backend / cli-backend 会真的拉起 opencode 二进制，跑之前想清楚

# 2) 三层端口都在
foreach ($p in @(8787,18080,10001)) {
  netstat -ano | Select-String ":$p\s" | Select-String 'LISTENING'
}

# 3) 真实调用计时（不要只看状态码）
# 4) 进程树：18080 的父进程应是 8787，10001 的父进程应是 18080
```

**端到端要打到真上游，不能只用 mock。** mock 能证明「头发出去了」，不能证明「上游认」。
真上游验证脚本：`scripts/verify-go-session.ts`（需要 `NODE_USE_ENV_PROXY=1` +
`HTTPS_PROXY`，否则 `fetch` 直连会超时）。

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

- **「HTTP 免费模型到底是被门禁还是只是没额度」——未区分，且这是本项目架构的关键前提。**
  2026-10-27 复核：`glm-5.3-flash-free` / `big-pickle` 用裸 HTTP 都能在 1.3s 内到达额度层
  并返回 429（不是被墙、不是 geo）。两条 429 与 CLI 拿到的文案完全相同，所以**无法从响应
  判断**。判定实验：UTC 零点（北京 08:00）后立刻发一次裸 HTTP——`200` 说明 HTTP 一直可用
  （那么「必须驱动 CLI」站不住）；`429` 说明是软门禁（CLI 才有价值）。**这个实验没做完之前，
  不要基于「HTTP 是死路」做架构决策。**
- **`beam-free` 单模型地区受限，不代表全部免费模型。** 2026-10-27：`beam-free` → 403
  `RegionError`；同一条链路、同一凭据下 `glm-5.3-flash-free` / `big-pickle` → 429 额度。
  查模型可用性必须**逐个试**，不能抽样一个就下结论。
- **恢复时刻已知，但无法提前查询。** 额度按 UTC 日重置（见上文实测），所以「何时恢复」
  可以从任一 429 的 `Retry-After` 直接推算，不需要轮询。真正缺的是「当前还剩多少」——
  官方没有额度查询接口（`/usage`、`/account`、`/config/providers` 均无），
  只能靠真实请求撞出来。
- **`transport=cli` 时，额度由可用转为耗尽，第一次调用要等 20s**（`cli-server.ts` 的
  `timeoutMs`）——CLI 不返回错误，只能等到超时再由日志解释。**`transport=http`（默认）
  没有这个代价**：实测 0.3–1.4s 就拿到 429 + `Retry-After`。这也是改回 HTTP 最直接的收益。
- **启动顺序仍是软约束。** 若 DSH 在 `18080` 就绪前加载插件，本次会话不会注册 free
  模型，只能重启 DSH。`src/free-lane.ts` 把 cli-server 绑成网关子进程即为此设计，
  但网关自身也需在 DSH 之前起来。
- **`go/v1` 与免费通道的 403/429 现在没有分开翻译。** `isFatalUpstreamError` 把 401/402/403
  一律当「不可重试」，方向是对的；但 `cli-server` 侧仍把「无响应」笼统说成「额度耗尽」。
  若将来再出现「等一天也没好」的报障，先看 CLI 日志里是 `FreeUsageLimitError`（真额度）
  还是别的，不要默认是额度。
