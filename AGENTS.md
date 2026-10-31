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

### 怎么判断「额度用完了」还是「指纹被改了」

两种失败的响应**长得几乎一样**（都是 `429 FreeUsageLimitError` + `Retry-After`），所以不能
凭"429"下结论。判据如下，**前提是探测必须从 oc2api 发**——Node 的 429 永远是指纹拒绝，
拿它判断额度必然误判。

| 观测 | 判定 | 处置 |
| --- | --- | --- |
| `200` | 正常 | — |
| `403 FreeTierError` | **指纹/形状变了**（oc2api 失效的典型信号） | 拉上游最新源码重建 `bin\oc2api.exe`；或临时切 `OPENCODE_CLI_TRANSPORT=cli` |
| `426 Upgrade Required` | 客户端自称的版本过旧 | 升级 oc2api |
| `403 RegionError` | **该模型**地区受限（`beam-free` 就是这样） | 换一个免费模型，与额度/指纹无关 |
| `429` + `Retry-After` **指向下一个 UTC 零点**（误差 ≤3 分钟） | **额度耗尽** | 等到那个时刻，不要重试 |
| `429` + `Retry-After` **指向别处** | **不是额度** | 按指纹 / 上游限流排查 |
| `429` 没有 `Retry-After` | 不是纯额度 | 按指纹排查 |
| **`402 insufficient_quota`**（"Free usage exceeded, subscribe to Go"） | **同样是额度耗尽** | 2026-10-24 实测出现过；别因为它不是 429 就当成别的错 |
| 跨过一个 UTC 零点后**仍是 429**，且 `Retry-After` 又指向下一个零点 | **指纹变了** | 额度每天会回来，指纹不会 |

一条现成的判据脚本（默认零额度，`--probe` 才发 1 次 `max_tokens=1` 的请求）：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8   # 否则 GBK 控制台下中文是乱码
python scripts\check-free-lane.py            # 进程/端口/health/models，全都不花额度
python scripts\check-free-lane.py --probe    # 区分额度 vs 指纹，花 1 次
```

脚本会把上次 429 的时间记到 `%TEMP%\opencode-free-lane-state.json`，用来支撑最后那条
「跨日仍 429」的判据。

**为什么不能只看「等了也没好」**：上游的额度是按 UTC 日给的，如果这个出口被别人抢光，
你今天等到了零点也可能几分钟内又被薅完——那仍然是额度，不是指纹。所以判据要用
`Retry-After` 的**指向**，而不是"等一等有没有好"。

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

**oc2api 的出网是单出口、直连**（2026-10-31 复核）：`internal/zen/client.go` 只用一个
`net.Dialer`，没有出口池、不读 `HTTP_PROXY`。`GET /ip` 实测报 `66.90.98.34`，而 `NO_PROXY`
只含 `opencode.ai`——它确实没走 7897。所以「换 Clash 节点绕 429」对免费档无效；要换出口只能
换机器/换网络，或部署多个 oc2api 实例交给上游聚合网关轮询（轮询在实例之间，不在实例内部）。
README 里「`proxies` 出口池」那套属于已退休的 opencode2api，**不要拿它推断 oc2api**。

**oc2api 必须设 `API_KEY`**：它监听 `0.0.0.0`，且把空 key 当匿名访问。不设等于把这台机器
的免费额度开放给整个局域网。`gateway.config.json` 里 `lanes.oc2api.apiKey` 与
`free-oc2api` 上游的 `apiKey` 必须是同一个值。

### 构建 oc2api 二进制（`bin/` 被 gitignore，不随仓库分发）

**最快路径：下载 Release 资产**（`.github/workflows/oc2api-release.yml` 从上游 tag 编译并发布）：

```powershell
New-Item -ItemType Directory -Force bin | Out-Null
Invoke-WebRequest -Uri "https://github.com/EDDY597/opencode-api-plugin/releases/download/oc2api-v4.4.0/oc2api.exe" -OutFile bin\oc2api.exe
Get-FileHash bin\oc2api.exe   # 与 Release 正文里的 sha256 对照
```

Release 正文由 workflow 生成，标签是 `oc2api-<上游 tag>`；要换上游版本就
**Actions → oc2api-release → Run workflow** 填新的 `upstream_tag`，或者推一个
`oc2api-vX.Y.Z` 标签。workflow 在发布前会自己跑一次 `/health` + `/models` 冒烟
（不花额度），所以资产不会是"能编译但起不来"的包。

**本地从源码构建**（没网盘、想改代码、或上游还没发 Release 时）：

```powershell
# 一次性：装 Go 1.24+（https://go.dev/dl/ 的 go<ver>.windows-amd64.zip，解压即用，无需管理员）
$env:GOPROXY = 'https://goproxy.cn,direct'
$env:GOTOOLCHAIN = 'local'
git clone --depth 1 https://github.com/zhuweiyou/oc2api.git E:\Agent\tools\oc2api
& "<go 解压目录>\bin\go.exe" -C E:\Agent\tools\oc2api build -o oc2api.exe ./cmd/oc2api
Copy-Item E:\Agent\tools\oc2api\oc2api.exe .\bin\oc2api.exe
```

换机器、或上游更新后重跑这几行。`OPENCODE_OC2API_PATH` 可指向别的位置。

**两份产物不一样大是正常的**：不加 tag 的本地构建带 mihomo 内核（完整构建），
`-tags nomihomo` 的瘦身版才约 8 MB、只认 http/socks5 代理。2026-10-30 实测（Go 1.27.3，
上游 `v4.4.0`）完整构建是 **65.5 MB**；而 2026-10-30 之前本机那份 `bin\oc2api.exe` 只有
13.4 MB——**上游发布页从来没有二进制资产**（`releases/latest` 只有 tag，没有 assets），
所以那份也不是下载来的，来源不明，与当前源码构建对不上。Release 一律按"加内核"的完整版
构建，与 AGENTS.md 里的命令一致。

本机验证脚本（零额度：只打 `/health`、`/models`）：

```powershell
& "C:\Program Files\nodejs\node.exe" scripts\verify-oc2api-release.mjs           # 静态检查 workflow
& "C:\Program Files\nodejs\node.exe" scripts\verify-oc2api-release.mjs --build   # 克隆上游 tag、构建、起 18091 冒烟
```

沙箱里 `C:\Users\<你>\go` 不可写，所以 `--build` 把 `GOCACHE`/`GOMODCACHE`/`GOPATH`/`GOTMPDIR`
全部指向 `%TEMP%` 下的临时目录；手动跑 `go build` 遇到 `Access is denied` 同理。

`git` 在这台机器上报 `schannel: ... SEC_E_NO_CREDENTIALS` 时，给单条命令加
`-c http.sslBackend=openssl` 即可（全局配置在 `C:\Program Files\Git\etc\gitconfig`，
沙箱里改不了）。

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

`bin/` 在 `.gitignore` 里，删了**无法从 git 恢复**（要么重新构建，要么没了）。2026-10-30 起
`bin\oc2api.exe` 可以从本仓库的 Release（标签 `oc2api-<上游 tag>`）重新下载，`bin\config.json`
仍然只能靠自己保存或重建。

现在 `bin/` 里有两个关键文件：

| 文件 | 少了会怎样 |
| --- | --- |
| `bin\oc2api.exe` | **免费模型全部 429** —— 网关没有 uTLS 出口。`oc2api-lane` 会在启动日志里报 `oc2api binary not found`，把 `lanes.oc2api.enabled` 误判成死配置 |
| `bin\config.json` | **只影响 DSH 插件（≥0.2.1，`free.mode: "service"`）**：它按 `env[OPENCODE2API_SERVER_KEY] ?? server_keys[0]` 找 key，找不到就 `no opencode2api server key`、free 路由整个不注册。网关自己的 18080 shim 不读它（2026-10-30 起 key 走 `lanes.cliServer.apiKey` → `lanes.oc2api.apiKey`） |

**注意插件读的是哪个 `bin\config.json`**（`lib/index.js:4239` 的 `defaultServicePaths`）：
`<插件包根>/../opencode-api-plugin/bin/config.json`，即**按插件安装位置推出的同级目录**，
不一定是你正在跑的这个 checkout。用 `OPENCODE2API_SERVER_KEY` 环境变量可以直接钉死 key，
也是唯一不受安装位置影响的写法。

旧版本的表格曾写「`bin\config.json` 缺失 → 18080 变 401」。**那条是错的**：经网关启动时
shim 从来没读过这个文件（`standalone.ts` 不传 `--config`），而 `apiKeys` 为空时
`cli-server.ts` 是**不鉴权**的。401 只出现在手工 `start-cli-server.cmd --config`、且 key
与插件发送的不一致时。

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

**2026-10-30 补：真正的触发条件是「带 `-RedirectStandardOutput` / `-RedirectStandardError`」。**
这条规则以前只被记成「`Start-Process` 会崩」，所以有人以为它是偶发的——实际上它每次都崩：

| 调用形态 | 结果 |
| --- | --- |
| `Start-Process -FilePath ... -PassThru`（不带重定向） | ✅ 正常，走 shell 执行路径，不复制环境块 |
| `Start-Process ... -RedirectStandardOutput x -RedirectStandardError y` | ❌ **必崩**，抛 `ArgumentException`：`Item has already been added. Key in dictionary: 'no_proxy' Key being added: 'NO_PROXY'` |

原因是重定向强制 `UseShellExecute=false`，.NET 要把父环境块塞进一个**大小写不敏感**的
`StringDictionary`，而本机环境块里 `no_proxy` 和 `NO_PROXY`（`http(s)_proxy` 同理）是两条独立
条目，于是撞键。**`$env:X = ...` 赋值也会制造第二个副本**，所以「先设个代理变量再
Start-Process」一样会炸。

崩点最阴的地方是：`tray.ps1` 开头有 `$ErrorActionPreference = 'SilentlyContinue'`，
异常被吞，托盘**静默自杀**（图标一闪就没），`8787` 一个端口都不开，`gateway.*.log` 被
`Start-Process` 重定向截断成 0 字节——看起来像「什么都没发生」。

三条已验证的绕法：

```powershell
# A) 在 PowerShell 里：先把每个大小写变体收敛成一个并重建环境块（tray/tray.ps1 用的就是这条）
#    2026-10-30 实测：SetEnvironmentVariable 删一个键时只会删掉**当前存储的那个拼写**，
#    另一个大小写变体仍在，所以必须循环到「按拼写逐个删干净」。判断「还有没有剩余」
#    不能用 GetEnvironmentVariable（大小写不敏感，永远能看到另一个变体），要枚举 Keys
#    做精确比较（-ceq），且删的是**枚举出来的那个键**、不是指定的拼写。
foreach ($name in 'HTTP_PROXY','HTTPS_PROXY','NO_PROXY') {
  $value = [Environment]::GetEnvironmentVariable($name, 'Process')
  if ($name -eq 'NO_PROXY' -and $value) { $value = $value + ',opencode.ai,api.deepseek.com' }
  for ($i = 0; $i -lt 4; $i++) {
    $variant = [Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -ceq $name.ToLower() }
    if (-not $variant) { $variant = [Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -ceq $name } }
    if (-not $variant) { break }
    [Environment]::SetEnvironmentVariable($variant, $null, 'Process')
  }
  if ($value) { [Environment]::SetEnvironmentVariable($name, $value, 'Process') }
}

# B) 完全绕开 PowerShell 的 Start-Process，用 .NET 自己起（重定向照样可用）
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'bin\oc2api.exe'; $psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
$psi.EnvironmentVariables['PORT'] = '18091'
[System.Diagnostics.Process]::Start($psi)

# C) 交给 vbs（wscript 直接 shell.Run node，不经过 .NET 字典）
```

第 5 条只解释了「为什么不能用 `Start-Process` 起服务」，**长驻服务的进程树问题仍然要看第 7 条**。

### 6. 改 `.ps1` 之后必须检查 UTF-8 BOM

本机 PowerShell 是 **5.1**，它读**无 BOM** 的 UTF-8 文件时按系统 ANSI 代码页（GBK/936）解释。
仓库里的 `.ps1`（`tray/tray.ps1` 等）是 **UTF-8 with BOM** 存的，而 **AI 工具的 `edit` /
`write` 写文件会丢掉 BOM**，于是：

- 中文注释和字符串全部变乱码（`重启服务` → `閲嶅惎鏈嶅姟`）；
- 乱码撑破字符串终止符，`Parser::ParseFile` 报出十几处「缺少终止符」「意外的标记」；
- 脚本一行都执行不了。托盘的表现就是「双击 vbs 没反应」。

2026-10-30 实测：`tray/tray.ps1` 被 `edit` 写成无 BOM（前 3 字节 `23 20 4C` = `# L`）后，
语法检查报 **11 处错误**，托盘启动即退出。补回 `EF BB BF` 后 0 错误。

改完必须验：

```powershell
$b = [System.IO.File]::ReadAllBytes((Resolve-Path 'tray\tray.ps1'))
'{0:X2} {1:X2} {2:X2}' -f $b[0],$b[1],$b[2]      # 必须是 EF BB BF
$errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'tray\tray.ps1').Path, [ref]$null, [ref]$errors)
$errors.Count                                      # 必须是 0
```

丢了就按原编码写回（**不要**用 `Set-Content -Encoding UTF8`，PS 5.1 与 PS 7 行为不同）：

```powershell
$p = (Resolve-Path 'tray\tray.ps1').Path
$text = [System.IO.File]::ReadAllText($p, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($true)))
```

顺带：`tray.ps1` 第 448、460 行的气泡提示文字**曾经**是乱码（`缃戝叧杩涚▼宸查€€鍑猴紝…`），
是历史上被 GBK 破坏留下的，不影响功能；2026-10-30 已按 UTF-8+BOM 写回修好（`网关进程已退出，托盘随之关闭` /
`网关已停止。{0}`），同时修掉第 457 行注释里的 `鈥?` 破折号残留。**以后改到这几行时别改回乱码**：
`git diff` 里如果出现连串的 `缃戝叧` 之类，就是编码又被破坏了。

`.ps1` 里的语法还要注意 PS 5.1 **不支持 `?.` 和 `??`**（那是 PS 7+）。写成 `?.Message`
会直接 `Unexpected token` 报错，同理被 `SilentlyContinue` 吞掉就变成「功能静默失效」。

### 7. 不要从 agent 会话里启动需要长期存活的服务

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
  "cliServer": { "enabled": true, "port": 18080, "apiKey": "<同 oc2api.apiKey>" }
}
```

**两条 lane 都默认关闭**（`enabled === true` 才启动）。2026-10-30 之前 `oc2api` 是
`enabled !== false`（默认开），于是没有 `lanes` 节的配置会先尝试起一个网络服务、再因为
key 为空失败——看起来像"设计好的提醒"，实际是半启动的状态，而且 `lanes.oc2api.apiKey`
与 `free-oc2api` 上游 `apiKey` 不一致时 oc2api 对每个请求都回 401，只有到请求阶段才暴露。
现在：**key 从上游继承**（`lanes.oc2api.apiKey ?? free-oc2api.apiKey`），不一致时启动日志
直接点名；`cliServer` 需要的 key 走 `lanes.cliServer.apiKey ?? lanes.oc2api.apiKey`，
**没有 key 就不启动 18080**（2026-10-30 之前它是不鉴权的开放端口）。

**顺序是硬约束**：oc2api 必须先就绪，cliServer 才能转发。`standalone.ts` 里用
`await` 串起来，就是为此。

**进程绑定已验证**（2026-10-28）：网关 pid → 两个子进程的 `ParentProcessId` 都指向它；
`Stop-Process` 网关后，18090 与 18080 一并消失。重启 DSH / 网关不会留下孤儿进程，
也不会出现「端口被上一代实例占着」。

**运行期自愈已验证**（2026-10-28）：`src/lane-watchdog.ts` 每 30 秒探一次本地端口
（`oc2api/health`、`shim/healthz`，都是静态响应，**不花额度**），哪条挂了就重启哪条。
实测：杀掉 oc2api → 45 秒内以新 pid 回来、父进程仍是网关；杀掉 18080 shim → 同样自愈。
间隔可用 `OPENCODE_LANE_WATCHDOG_MS` 覆盖（最小 5000）。

### DSH 插件为什么"必须让它一加载就健康"

插件只在**加载那一刻**判一次：`buildFreeRuntime()` 探 `18080/healthz`，失败就把
`freeRuntime` 置空并记一条 error。之后那个 60 秒的定时器只刷新**模型列表**
（`refreshOnce`），**不会重建 runtime**——所以本会话免费模型就没了，只能重启 DSH。

它原来还有一层兜底：18080 不健康时自己去 spawn `bin\opencode2api.exe`。**那个文件已经不存在**，
所以现在没有兜底，只有：

| 防线 | 覆盖什么 | 位置 |
| --- | --- | --- |
| `HKCU\...\Run` → `start-gateway-hidden.vbs` | 开机时把网关拉起来 | 用户级自启，无需管理员 |
| `lane-watchdog.ts` | 网关运行中 lane 挂掉 | 网关进程内 |
| 人工重启 DSH | 开机时 DSH 抢在网关前面加载了插件 | 唯一残余风险 |

**残余风险**：Run 键与 DSH 的自启顺序没有保证。如果开机时 DSH 先加载插件、而网关还没把
18080 起来，这次会话就没有免费模型——**重启一次 DSH 即可**（那时网关必然已在跑）。
要彻底消除，只能改插件让它失败后重建 runtime（插件在 `E:\Agent\dsh-opencode-gateway`，
是独立仓库，改完要 build + 重启 DSH）。

**已验证的链路**：
- 网关 `free/glm-5.3-flash-free` → 200 / 1.3s
- 18080 shim（带 key）→ 200 / 2.3–3.0s，模型列表跟随 oc2api（**8 个**；旧文档写的 9 个是过期的，
  `nemotron-3-ultra-free` 早已下架）

**18080 shim 的鉴权（2026-10-30 修）**：以前 `standalone.ts` 只传 `httpBase`/`apiKey`，不传
`--config`，于是 `cli-server` 的 `apiKeys` 是空数组，而空数组的含义是**不鉴权**——本机任何
进程都能经 18080 白嫖免费额度。现在 `free-lane.ts` 用 `--api-key <lanes.cliServer.apiKey ?? lanes.oc2api.apiKey>`
启动，没 key 就不起；同时传 `--parent-pid`，父进程消失后 shim 拒绝继续服务（只放行 `/healthz`），
防止网关重启时 `stopFreeLane()` 杀不掉、下一代默默采纳上一代的僵尸。

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

**改完要跑端到端，但不能拿额度当代价。** 把「端到端」理解成**走到真实边界为止**：
改了上游地址 → 打一次 `/models` 或 `/health` 就够证明链路通了，不必真跑一次推理。
只有改动了**请求体构造**（头、形状、session、模型 id）时才必须真发一次 chat，因为
那些东西只有上游能判定对错。这两类要分开算账。

我犯过的具体错误：

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
| `scripts/verify-oc2api-release.mjs` | 校验 Release workflow；`--build` 还会克隆上游 tag、构建、起 18091 冒烟（零额度） |
| `scripts/verify-free-http-shim.py` | 起临时 18099 实例测 cli-server 的 http 传输 |
| `scripts/verify-go-session.ts` | `go/v1` 的 session 头（需 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`） |
| `scripts/measure-http-latency.ts` | 流式 TTFB vs 总耗时 |

**默认不要发任何会花钱的请求。** 用户 2026-10-28 明确要求：不要消耗他的额度，必要时才探测。
把下面这张表当成纪律，而不是建议：

| 操作 | 花额度吗 | 用途 |
| --- | --- | --- |
| `GET /health`（oc2api）、`GET /healthz`（cli-server） | ❌ | 就绪判断，本地静态响应 |
| `GET /v1/models`（网关 / 18080 / oc2api 的 `/models`） | ❌ | 模型发现，不触发推理 |
| `GET /ip`（oc2api） | ❌ | 核对出口（它查的是一个外部 IP 服务，不是 zen） |
| `netstat` / `Get-CimInstance` / 进程树 | ❌ | 进程绑定回归 |
| **`POST /v1/chat/completions`** | ✅ **每个都算** | 只有改动了请求路径、且非验证不可时才发 |

改完默认只验前四类。要发 chat 请求前先问自己：这个失败**能不能从代码或本地响应推断出来**？
能就不要发。一次「端到端跑一遍」= 至少 2 次推理调用，别习惯性地做。

**遇到额度错误立即停止测试。** 每次调用都在消耗额度，盲目重试验证会加速耗尽。
实测我在额度已耗尽后又发了 16 次无效请求；2026-10-28 又为了做 OC2API 对照连发了十几次。

---

## 环境事实速查

| 项 | 值 |
| --- | --- |
| Node（网关运行用） | `C:\Program Files\nodejs\node.exe`（v26，原生跑 TS） |
| Node（PATH 上的） | v16.9.1 —— **太老，不能跑 TS** |
| Go 工具链（构建 oc2api 用） | `E:\Agent\tools\go-install\go\bin\go.exe`（1.27.3，解压版，未进 PATH） |
| oc2api 源码 / 构建目录 | `E:\Agent\tools\oc2api`；产物在 `bin\oc2api.exe`（也可从本仓库 Release `oc2api-v4.4.0` 下载） |
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
- **额度用量无法提前查询，官方也不公布配额数字。** 2026-10-28 查过官方文档
  （`opencode.ai/v2/docs/console/models`）：它只列出**免费模型的名单**、定价写 `Free`、
  每项注 "available for a limited time"，**没有任何次数/ token 数字**；也没有查询接口
  （`/usage`、`/account`、`/config/providers` 均无）。能确定的只有「按 UTC 日重置」。
  因此回答「还剩多少」时只能给**已用量**，不能给上限：

  ```powershell
  # 今天实际调过多少次上游（零额度，纯读日志）
  Select-String -Path gateway-debug.log -Pattern '--> .*model=' |
    Where-Object { $_.Line -match '^2026-10-28' } |
    ForEach-Object { [regex]::Match($_.Line,'model=(\S+)').Groups[1].Value } |
    Group-Object | Sort-Object Count -Descending
  ```

  2026-10-28 实测：当天 89 次上游调用，其中免费档仅 **9 次**（其余 80 次走
  `go/deepseek-v4.1-flash`）。历史日志（10-17 起）里免费档总量约 112 次，11 天平均每天
  10 次左右——**从来没接近过上限**，唯一一次耗尽发生在 10-24，且是以 `402` 形态出现的。
- **免费模型池本身也在变。** 官方文档 2026-10-28 列了 11 个（含 `nemotron-3-ultra-free`），
  而当天 `/inference/v1/models` 只返回 9 个——`nemotron-3-ultra-free` 已不在列表里，
  但 `gateway-debug.log` 里 10 月中旬还有它的调用记录。**名单以 `/models` 实时结果为准**，
  不要照抄文档。
- **启动顺序仍是软约束，但已加防线。** 若 DSH 在 18080 就绪前加载插件，本次会话不会注册
  free 模型，只能重启 DSH。现有三条防线（Run 键自启 / 网关内 watchdog / 人工重启 DSH）见
  「DSH 插件为什么必须让它一加载就健康」；残余风险只剩开机竞态。
- **Run 键是用户级的，不是计划任务。** `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
  里的 `OpenCodeGateway` = `wscript.exe "<repo>\start-gateway-hidden.vbs"`。不要改成
  `schtasks`——这台机器没有管理员权限（见下表）。删掉这一项就等于关掉开机自启。
- **`go/v1` 与免费通道的 403/429 现在没有分开翻译。** `isFatalUpstreamError` 把 401/402/403
  一律当「不可重试」，方向是对的；但 `cli-server` 侧仍把「无响应」笼统说成「额度耗尽」。
  若将来再出现「等一天也没好」的报障，先看 CLI 日志里是 `FreeUsageLimitError`（真额度）
  还是别的，不要默认是额度。
