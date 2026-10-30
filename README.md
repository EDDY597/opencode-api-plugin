# opencode-api-plugin

本地多协议 LLM 网关 —— 一个端点聚合多个上游，自动在 **Chat Completions / Anthropic Messages / Responses** 三种协议之间转换。

内置 **opencode2api 嵌入式上游**：驱动本机 opencode 运行时，把 OpenCode Zen 免费模型变成网关的一个上游，单进程、零依赖、无需安装独立的 opencode2api 服务。

零依赖（仅用 Node 内置模块，无需 `npm install`），Windows 友好（脚本启动 + 系统托盘）。

> **DeepSeek Harness 桌面用户**：配套插件 [EDDY597/dsh-opencode-gateway](https://github.com/EDDY597/dsh-opencode-gateway) 把本网关（订阅模型）与本机免费档一并接入 DSH 的模型菜单，自带模型管理设置页；其免费档路由内嵌 opencode2api，不依赖本网关运行。**该插件的“OpenCode Go”卡片只认 `go/` 前缀**：请把 `opencode-go` upstream 的 `prefix` 设为 `go`（示例配置已如此），并在 `~/.dsh/.env` 写入 `OPENCODE_GATEWAY_KEY=<本网关 token>`；缺任何一项，刷新时只会得到空列表。

## 解决什么问题

- 客户端各说各话：有的只发 OpenAI Chat Completions，有的只发 Anthropic Messages（如 Claude Code 类工具），有的用 Responses API。网关在入口做协议转换，任何客户端都能接任何上游。
- 上游各说各话：OpenCode Go 官方端点、OpenCode Zen、嵌入式本地 opencode、第三方 OpenAI 兼容服务，统一聚合到 `http://127.0.0.1:8787/v1`。
- 模型名冲突：不同上游可能有同名模型。用 `前缀/模型名` 路由，前缀自动剥离后转发。

```
客户端（任意协议）
   │  /v1/chat/completions │ /v1/messages │ /v1/responses
   ▼
网关 127.0.0.1:8787        ← 本项目（单进程）
   │  按模型名前缀路由 + 协议转换
   ├──► OpenCode Go（官方预设，读取本地 opencode 登录态）
   ├──► OpenCode Zen（官方 API，配 API Key）
   ├──► 嵌入式 opencode2api（type: "opencode2api"，自动拉起 opencode serve）
   └──► 任意 OpenAI 兼容上游（自定义 baseURL）
```

## 环境要求

- **Node ≥ 22.6**：源码是 TypeScript，靠 Node 原生类型剥离直接运行（仓库不发布构建产物）。启动脚本已优先使用 `C:\Program Files\nodejs` 的安装，避免被 PATH 里的旧版 Node 干扰。
- Windows 下可用附带的 cmd/vbs/托盘脚本；其他平台直接 `node src/standalone.ts`。
- **免费档额外需要 `bin\oc2api.exe`**：第三方 Go 二进制，`bin/` 被 gitignore，所以仓库里没有。装法二选一——
  从 [Releases](https://github.com/EDDY597/opencode-api-plugin/releases) 下 `oc2api-<上游 tag>` 的 `oc2api.exe`
  （Actions 里的 `oc2api-release` 工作流编译 + 冒烟后发布），或按 `AGENTS.md`「构建 oc2api 二进制」用 Go 1.24+ 自己编。
  没有它时网关照常启动，只是 `free/` 模型不可用（日志报 `oc2api binary not found`）。

## 快速开始

```bash
# 1. 准备配置
cp gateway.config.example.json gateway.config.json
#    编辑 gateway.config.json：填上游的 apiKey；
#    token 留空即网关免鉴权（仅限 hostname 为回环地址），想让客户端"不填 key"就保持为空

# 2. 启动
start-tray-hidden.vbs          # 托盘模式（推荐，可配置为开机自启）
start-gateway.cmd              # 前台窗口，可看日志（调试用；注意该窗口承载网关进程，关窗即停）
start-gateway-hidden.vbs       # 裸网关静默后台运行（无托盘监管，一般不用）

# 3. 验证
curl http://127.0.0.1:8787/v1/models
#    token 非空时：curl -H "Authorization: Bearer <token>" http://127.0.0.1:8787/v1/models
```

## 系统托盘

`tray\tray.ps1`（经根目录 `start-tray-hidden.vbs` 或 `tray\tray.cmd` 启动）是网关的托盘管家，**图标存在 = 网关进程在运行**：

- 单实例互斥锁：同一托盘误开双份会静默退出（另撞上废弃互斥锁也能正常启动）
- 启动时若网关未运行则自动拉起（隐藏控制台窗口——网关不再和任何可见窗口绑定生命周期）；已运行则直接接管
- 托盘**绿色**图标 = 网关健康；**灰色** = 启动中/异常
- **悬停**显示 OpenCode 额度：5h / 周 / 月窗口的剩余百分比与重置时间（需 Go 订阅权益，未订阅显示对应提示）
- **右键菜单**：
  - **重启服务** —— 杀掉网关进程树并重新拉起（改完 gateway.config.json 后用它生效）
  - **设置...** —— 弹窗编辑嵌入式上游的常用参数：OpenCode API Key（Zen 密钥，同时用于后端付费模型与额度查询）、opencode 可执行文件路径、调试日志开关；保存后自动重启生效
  - **退出** —— 停止网关并关闭托盘
- 网关进程退出（崩溃/被杀）时托盘弹出气泡提示并自动关闭，图标不会谎报状态
- 健康检查与额度查询全部在后台线程执行，UI 线程零网络 I/O——右键菜单不会再因网关/代理变慢而卡死
- 停止"附加模式"下发现的外部网关时同样杀整个进程树，嵌入式后端不会变成孤儿被下次启动收养
- 代理环境变量兜底：托盘/启动脚本发现进程环境缺 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` 时，自动从注册表用户级环境变量补齐——从任何 shell（计划任务、终端）启动链路都完整

注意：托盘与网关是同生关系——关托盘即停网关。想让网关脱离托盘常驻，用 `start-gateway-hidden.vbs` 启动即可（此时托盘只做监控与显示）。

## 配置参考

顶层字段（均可被环境变量覆盖，见下文）：

| 字段 | 默认 | 说明 |
|:-----|:-----|:-----|
| `hostname` | `127.0.0.1` | 监听地址。**保持回环**：`token` 为空时网关拒绝在非回环地址上启动（见下） |
| `port` | `8787` | 监听端口 |
| `token` | (空) | 网关自身的 Bearer 鉴权；设置后所有 `/v1/*` 请求必须携带。**留空即免鉴权**，客户端不必填 Key |
| `upstreams` | 内置 OpenCode Go 预设 | 上游列表，见下表 |

> **空 token 的安全约束**：`token` 为空时，任何能连到端口的人都等于拥有你的模型额度。因此 `hostname` 不是回环（`127.0.0.1` / `localhost` / `::1`）时会**直接拒绝启动**并报 `TOKEN_REQUIRED`。想监听 `0.0.0.0` 或局域网地址，必须同时设置 `token`。

### `lanes`：网关自己托管的两个本地服务

两者**默认都不启动**，必须显式 `enabled: true`。它们随网关启动、随网关退出（没有独立的开机自启条目）。

| 字段 | 默认 | 说明 |
|:-----|:-----|:-----|
| `lanes.oc2api.enabled` | `false` | 拉起 `bin/oc2api.exe`（18090），免费模型的唯一出网通道 |
| `lanes.oc2api.port` | `18090` | 监听端口；须与 `free-oc2api` 上游的 `baseURL` 一致 |
| `lanes.oc2api.apiKey` | (必填) | 空则拒绝启动（oc2api 监听 `0.0.0.0`，空 key 等于匿名）。省略时从 `free-oc2api` 上游的 `apiKey` 继承；两者不一致会 401，启动日志会点名 |
| `lanes.cliServer.enabled` | `false` | 拉起 `src/cli-server.ts`（18080），转发到 oc2api。**只有 DSH 插件需要** |
| `lanes.cliServer.port` | `18080` | 插件默认 `free.serviceUrl` 就是这个端口 |
| `lanes.cliServer.apiKey` | 同 `lanes.oc2api.apiKey` | 18080 的 Bearer 鉴权。**为空就不启动**（否则是一个谁都能用的开放端口）。若插件读不到 `bin/config.json`，把这个值同时写进 `~/.dsh/.env` 的 `OPENCODE2API_SERVER_KEY` |

最小免费档配置（自己用网关、不接 DSH 插件）：

```json
{
  "lanes": { "oc2api": { "enabled": true, "apiKey": "<随机 64 位 hex>" } },
  "upstreams": [
    { "id": "free-oc2api", "type": "openai", "prefix": "free",
      "baseURL": "http://127.0.0.1:18090/v1", "apiKey": "<同一个值>", "enabled": true }
  ]
}
```

`gateway.config.example.json` 里有完整版本（含 `lanes` 注释、`free-oc2api` 与已标注为 legacy 的 `free-cli`）。

`upstreams[]` 字段：

| 字段 | 说明 |
|:-----|:-----|
| `id` / `name` | 标识与显示名 |
| `type` | `opencode-go`（官方预设，自动读本地登录态与协议映射）或 `openai`（通用 OpenAI 兼容上游）；也可以直接把 type 写成 `anthropic` / `responses` 作为该上游的默认协议 |
| `prefix` | 模型名前缀，如 `free`；匹配 `free/模型名` 的请求路由到此上游并剥离前缀 |
| `baseURL` | 上游 API 根地址（**需含版本段**，如 `http://127.0.0.1:10000/v1`）；`opencode-go` 预设可省略 |
| `apiKey` | 发给上游的密钥；`opencode-go` 预设可省略（自动读本地 opencode 凭据）；嵌入式上游无需（由网关 `token` 统一鉴权） |
| `protocol` | 该上游的默认协议：`openai`（默认）/ `anthropic` / `responses`；嵌入式上游固定 chat 且原生支持 Responses，无需设置 |
| `responsesPrefixes` / `anthropicPrefixes` | 按模型名前缀强制指定协议，优先于 `protocol`（嵌入式上游忽略） |
| `responsesModels` / `anthropicModels` / `protocols` | 按精确模型名指定协议（`protocols` 是 `模型名: 协议` 映射） |
| `models` | 模型白名单（数组或对象），限制 `/v1/models` 聚合与可转发范围 |
| `modelRewrite` | 模型 id 改名映射（如 `{"opencode-go/": "go/"}`）：`/v1/models` 按映射改名展示，请求侧自动反向映射回上游真实 id；键取最长匹配 |
| `authHeader` | 上游鉴权方式：`bearer`（默认）/ `x-api-key` / `both` |
| `headers` | 附加到每个上游请求的自定义头 |
| `sessionHeader` | `true` 时向上游透传 `x-opencode-session` 会话头 |
| `modelParams` | 按模型强制覆盖请求参数（如 `{"模型名": {"temperature": 0}}`） |
| `reasoningEffortMap` | `reasoning_effort` 值重映射（如 `{"high":"medium"}`） |
| `stripParams` | 转发前从请求体删除的参数名 |
| `paramFallback` | 默认 `true`：上游返回 400/422 且疑似不支持推理类参数时，剥离这些参数自动重试一次 |
| `retry` | 瞬断重试：`{"attempts": 3, "maxDelayMs": 20000}`（默认）。对 429/5xx/连接失败按 500ms 起指数退避（±10% 抖动，尊重 `Retry-After`）；401/400 等永久错误不重试 |
| `timeoutMs` | 默认 `120000`：上游响应头必须在此时间内到达（TTFB 超时），超时按可重试错误处理；不限制已开始的流式输出，`0` 关闭 |
| `usageBase` / `usage` | `/api/usage` 额度聚合的上游地址；`usage: false` 排除该上游 |
| `enabled` | 开关，默认 `true` |

嵌入式上游（`type: "opencode2api"`）的附加字段：

| 字段 | 默认 | 说明 |
|:-----|:-----|:-----|
| `baseURL` | `http://127.0.0.1:10001` | 本地 opencode 后端地址（网关自动拉起并托管） |
| `opencodePath` | `opencode` | opencode 可执行文件路径（找不到时按 PATH 与常见安装位置自动搜索） |
| `manageBackend` | `true` | 后端不在时自动 spawn `opencode serve`，随网关退出而关闭 |
| `serverPassword` | (空) | 后端 Basic Auth 密码（经 `OPENCODE_SERVER_PASSWORD` 环境变量传给后端） |
| `zenApiKey` | (空) | 透传为后端的 `OPENCODE_API_KEY`（解锁付费模型）。**默认会被本机登录态覆盖**，见下一行 |
| `preferAuthFile` | `true` | 为 `true` 且 `~/.local/share/opencode/auth.json` 已有 opencode 登录态时，**忽略 `zenApiKey`**，让后端沿用 CLI 的账号。可避免"CLI 能用、网关报额度不足"的身份错位 |
| `disableTools` | `true` | 禁用 OpenCode 内置工具（经 tool-lock 插件执行，免费档必需） |
| `internalAllowedTools` | (空) | 内置工具白名单（逗号分隔或数组） |
| `promptMode` | `standard` | `standard` 或 `plugin-inject` |
| `omitSystemPrompt` | `false` | 忽略客户端传入的 system prompt |
| `requestTimeoutMs` | `300000` | 单次请求超时（含上游重试） |
| `useIsolatedHome` | `false` | Unix 下使用隔离 fake-home（Windows 恒用真实用户目录） |
| `autoCleanupConversations` | `false` | 定期清理会话存储 |
| `eventIdleTimeoutMs` / `eventFirstDeltaTimeoutMs` | `8000` / `30000` | 事件流空闲/首包超时 |
| `debug` | `false` | 调试日志 |

## 与 DSH 插件对接（Go 卡）

DSH 插件 [EDDY597/dsh-opencode-gateway](https://github.com/EDDY597/dsh-opencode-gateway) 的「OpenCode Go」卡并不直接展示网关的全部模型，而是只保留 **`go/` 前缀**的条目。网关侧必须让 `opencode-go` upstream 以 `go` 为前缀暴露，并让插件拿到网关 token；任何一项不对，卡片刷新就会显示「端点没有返回任何模型」。

最小可用配置（`gateway.config.json`）：

```json
{
  "hostname": "127.0.0.1",
  "port": 8787,
  "token": "<自己生成一个 token>",
  "upstreams": [
    {
      "id": "opencode-go",
      "name": "OpenCode Go",
      "type": "opencode-go",
      "prefix": "go",
      "enabled": true
    }
  ]
}
```

不写 `apiKey` 时读本机 `opencode auth login` 的登录态；要显式指定就加 `"apiKey": "..."`，且必须是已开通 Go 订阅的 Key（见下面第 3 条）。

检查清单：

1. `type` 必须是 `opencode-go`（官方端点 + 本机登录态 + 协议映射）。
2. `prefix` 必须是 **`go`**。写成 `opencode-go` 时 `/v1/models` 会列成 `opencode-go/...`，插件的 Go 卡按设计会把它当成"本地后端目录"丢弃，刷新结果为空。
3. `enabled` 必须是 `true`。`apiKey` 必须是**已开通 OpenCode Go 订阅**的 Key；不确定就删掉这一行，让网关读本机 `opencode auth login` 的登录态。用错 Key 时模型列表可能仍正常（目录是公开的），但聊天会返回 `403 An active OpenCode Go subscription is required to use Go models`。
4. 网关 `token` 与 `~/.dsh/.env` 的 `OPENCODE_GATEWAY_KEY` 必须一致（网关未设 token 时，后者填任意非空值）。
5. 改完重启网关（托盘 → 重启服务），然后验证：

```bash
curl http://127.0.0.1:8787/v1/models
# token 非空时加 -H "Authorization: Bearer <token>"
# 期望同时看到 go/... 和（若启用了嵌入式上游）free/...
```

只有 `free/...` 而没有 `go/...`，说明第 1–3 条没生效；请求 401 或完全为空，检查第 3–4 条与 `gateway.err.log`。

### `opencode-go` 的 Key 从哪里读

配置里不写 `apiKey` 时，网关按以下顺序取 Key：

1. 环境变量（网关进程的环境，托盘/启动脚本会继承）：`OPENCODE_GO_API_KEY` → `OPENCODE_API_KEY` → `OPENCODE_ZEN_API_KEY`
2. `gateway.config.json` 顶层 `apiKey` / `key` / `"opencode-go".key` / `models["opencode-go"].apiKey`
3. 本机 `opencode auth login` 的登录态文件，依次尝试：
   - `%OPENCODE_AUTH_FILE%`（若设置）
   - `%XDG_DATA_HOME%\opencode\auth.json`
   - `~/.local/share/opencode/auth.json`（本机为 `C:\Users\<你>\.local\share\opencode\auth.json`）
   - `%APPDATA%\opencode\auth.json`
   
   取其中 `"opencode-go"` 条目；没有该条目时取 `"opencode"`。

因此推荐顺序是：先 `opencode auth login`（`opencode auth list` 能确认当前账号），网关就不需要写 Key；要指定另一个账号时，再在 `gateway.config.json` 里加 `apiKey`，或给网关进程设 `OPENCODE_GO_API_KEY`。三者同时存在时按上面的优先级覆盖。

> 免费档当前由 `bin\` 下的 Go 版 [oc2api](https://github.com/zhuweiyou/oc2api) 服务提供（启动脚本自动拉起，详见下文「实战：免费模型」）。`bin/` 不进 git，`oc2api.exe` 从本仓库 [Releases](https://github.com/EDDY597/opencode-api-plugin/releases) 的 `oc2api-<上游 tag>` 资产下载，或按 `AGENTS.md`「构建 oc2api 二进制」从源码构建。Go 订阅模型才需要上面的配置。

## 模型命名与协议路由

请求里的模型名按以下顺序解析：

1. **前缀匹配**：`前缀/模型名` 命中某个上游 → 剥离前缀转发（多个前缀命中时取最长）。
2. **无前缀回退**：剥掉 `opencode-go/`、`opencode/` 后发给第一个启用的上游。

发给上游的协议按以下顺序判定（决定转换方向）：

1. `protocols` / `responsesModels` / `anthropicModels` 的精确模型名声明
2. `responsesPrefixes`、`anthropicPrefixes` 前缀声明
3. 上游的 `protocol` 默认值

OpenCode Go 预设内置了一批 Responses 模型映射（grok-4.x 等）。

## API 端点

| 方法 | 路径 | 说明 |
|:-----|:-----|:-----|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions（含流式） |
| `POST` | `/v1/messages` | Anthropic Messages（含流式），自动与上游协议互转 |
| `POST` | `/v1/responses` | Responses API：仅当目标模型被声明为 responses 协议时**原样透传**到上游 `/responses`，否则返回 501 |
| `GET` | `/v1/models`、`/v1/models/{id}` | 聚合所有启用上游的模型列表（自动加前缀） |
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/usage` | 聚合配置了 `usageBase` 的上游额度 |

## 实战：免费模型（CLI 通道，实测可用）

> **2026-10-26 实测结论**：OpenCode 的免费额度**挂在官方客户端本身上，不挂在 API Key 上**。这一点决定了所有 HTTP 转发方案（含 Go 版 opencode2api）的成败，先看清楚再选路。

实测证据（同一模型 `big-pickle`、同一台机器、同一时刻）：

| 调用方式 | 结果 |
| --- | --- |
| `opencode run`（**干净数据目录，无 auth.json、无任何 Key**） | ✅ 正常返回 |
| 裸 HTTP `POST https://opencode.ai/zen/v1/messages` + 你的 `oc_sk_` Key | ❌ 429 `FreeUsageLimitError` |
| 同上，但伪造 `User-Agent: opencode/1.18.34` | ❌ 429（UA 不是判定依据） |
| opencode2api 匿名通道 `/inference` | ❌ 429，`Retry-After` ≈ 9 小时 |

关键点：**你的 Key 对免费模型没有任何额度**，换 Key、填 `zen_keys`、改 UA、切 `anonymous` 都无效。而 CLI 在完全没有凭据的情况下反而能用——额度判定依据的是「是不是官方客户端进程」，不是「谁在转发」。

### 方案：`src/cli-server.ts`（本仓库新增）

把 `opencode run` 当成后端进程驱动，对外暴露 OpenAI 兼容接口，网关和 DSH 插件都能接入：

> **2026-10-30 更新**：下面这套是**旧方案**。现在免费档的推荐路线是 `bin\oc2api.exe`
> （uTLS）+ `free-oc2api` 上游，见「配置参考 → `lanes`」。宿主机能跑 oc2api 时，
> `cli-server` 只作为 DSH 插件用的 18080 转发垫片存在（`lanes.cliServer`），由网关托管。

```
DSH 插件 ─────────────────────────────┐
                                      ├──► cli-server :18080 ──► opencode run ──► 免费模型
客户端 ──► 网关 :8787 ──► free/ 上游 ──┘
```

启动（**端口必须是 18080**，原因见下）：

```bash
start-cli-server.cmd
```

#### 为什么必须固定 18080，以及为什么必须开机自启

DSH 插件（`dsh-opencode-gateway`）的 `free` 路由**是直连 18080 的，不经过 8787**。它的默认配置是 `free.mode = "service"`、`free.serviceUrl = "http://127.0.0.1:18080"`，且 `manageService = true`——也就是说：

> 插件启动时探 `18080/healthz`，**没人应答就自己去拉起 `bin/opencode2api.exe`**。

于是踩过一个典型故障：手动起了 CLI 服务、插件也正常，但**重启 DSH 后 18080 被 opencode2api 抢回**，免费模型又开始报「额度已用尽」。原因是 CLI 服务没有自启，插件等不到它就走了默认那条已经失效的路。

解决办法是让 CLI 服务**先于 DSH 常驻**：

```bash
install-cli-autostart.cmd          # 写入 HKCU\...\Run，登录即后台启动
install-cli-autostart.cmd remove   # 取消
```

它通过 `start-cli-server-hidden.vbs` 无窗口启动。只要 CLI 服务已在监听，插件检测到健康就会**原样复用、绝不重启**（`ensureServiceRunning` 里 `serviceHealthy` 为真就直接 return）。

#### 鉴权约定

> 2026-10-30 起，**网关托管的 18080 不再读 `bin/config.json`**：key 由 `lanes.cliServer.apiKey`（省略则用 `lanes.oc2api.apiKey`）传入，没有 key 时这条 lane 直接拒绝启动。以下只适用于手工 `start-cli-server.cmd`。

手工启动时用 `--config bin/config.json` 复用同一份 key：

- `start-cli-server.cmd` 已自动带上 `--config "%~dp0bin\config.json"`
- 无 key 调用返回 `401 {"error":{"message":"invalid local API key","type":"authentication_error"}}`
- `/healthz`、`/health`、`/v1/health` 不校验 key（供探活）

DSH 插件（`dsh-opencode-gateway` ≥0.2.1，`free.mode: "service"`）的取值顺序是
`env[OPENCODE2API_SERVER_KEY] ?? bin/config.json 的 server_keys[0]`，而那里的 `bin/config.json`
是按**插件安装位置**推出的 `<包根>/../opencode-api-plugin/bin/config.json`，不一定是你正在跑的
checkout。插件与网关不在同一棵树里时，用 `OPENCODE2API_SERVER_KEY` 钉死同一个 key。

已验证能力：

- 非流式 / 流式（SSE，含 `[DONE]` 与 usage 帧）
- `/v1/responses`（非流式 + 流式事件序列）——插件在 Responses 协议下会转发此路由
- 多轮上下文：网关每次收到完整 `messages`，适配器把历史拍平成一次 prompt 注入（不依赖 CLI 会话状态，客户端裁剪历史也不会错）
- 工具调用：CLI 跑自己的 agent 循环（`--auto` 自动批准），模型会真的执行命令；调用方的 `tools` 定义被忽略
- 计费：`cost: 0`，usage 取自 CLI 的 `step_finish` 事件

单次请求实测约 **8–30 秒**（冷启动偏慢），比 HTTP 直连明显慢——这是每次都要拉起一个 CLI 进程的代价。

已知取舍（实现时踩过的坑，见 `src/opencode-local/cli-backend.ts` 注释）：

1. **不要设置 `XDG_DATA_HOME`**。为绕开中文用户名路径问题重定向 XDG 会让 CLI 永久挂起（实测 70s 内零事件，正常只要 ~10s）。
2. 必须 spawn 真正的 `opencode.exe`，不要 spawn `.cmd` 垫片 + `shell: true`，否则 stdout 被 cmd.exe 干扰导致 NDJSON 流卡死（实测挂 180s）。
3. `stdio[0]` 要设为 `ignore`，否则 CLI 可能等待 stdin。
4. CLI 把上游故障伪装成正常回复文本（如 `Unexpected server error. Check server logs for details.`，退出码 0）。适配器已把它归类为失败并返回非 200，避免假成功。

### 旧方案一：Go 版 opencode2api（失败）

免费档原本走 `bin\` 下的 [opencode2api](https://github.com/jasonxu114514/opencode2api)（Go，MIT）独立服务。2026-10 起 OpenCode 收紧了免费档的客户端检测：裸 API 调用直接 403 `FreeTierError`（free tier can only be used from within OpenCode），并按出口 IP 统计免费额度，打满后返回 429 `Free usage limit reached` 且间隔性恢复。该服务以完整客户端保真度访问上游——Bun TLS 指纹（uTLS 复刻 ClientHello）、OpenCode 2.1 版本号与 `/inference` 路由、逐字节对齐请求体——并支持多出口轮换、单出口打满后冷却 15 分钟（`free_tier_block_seconds`）、匿名通道（无需任何账号，`anonymous: true`）。

**但实测（2026-10-26）这条路当前已不可用**：`/inference` 匿名池返回 429 且 `Retry-After` 约 9 小时，轮换出口无法绕过账号级额度。保留本节的配置说明仅为历史参考；要恢复免费模型请用上面的 CLI 通道。


`bin\config.json`（服务自身配置，已被 .gitignore 忽略）：

- `listen`: `127.0.0.1:18080`；`server_keys`: 客户端访问本服务用的本地 Key。
- `proxies`: 出口池，示例 `["direct", "http://127.0.0.1:7897"]`；出口被打满会冷却并轮换到下一个，额度恢复后自动回归。
- `zen_keys`: 可选填 Zen Key（如 `~/.local/share/opencode/auth.json` 里 `opencode` 条目的 `oc_sk_` Key）走账号身份；匿名通道与账号通道的免费额度相互独立，服务会自动在多条通道间重试。
- `models.free_only: true`：只暴露免费模型，与网关的 `free` 前缀对应。

`gateway.config.json`：

```json
{
  "id": "free-opencode2api",
  "name": "OpenCode Free (opencode2api Go)",
  "type": "openai",
  "prefix": "free",
  "baseURL": "http://127.0.0.1:18080/v1",
  "apiKey": "<bin/config.json server_keys 中的一项>",
  "protocol": "openai",
  "enabled": true
}
```

- 启动：`start-gateway.cmd` / `start-gateway-hidden.vbs` 会先检测 18080 端口，没有监听就拉起服务（自身管理代理出口，不需要网关的 `HTTP(S)_PROXY`）；`stop-gateway.ps1` 会把它一并停止。
- 客户端接入：地址 `http://127.0.0.1:8787/v1`，模型名如 `free/glm-5.3-flash-free`。**注意模型名没有 `opencode/` 段**——Go 服务直接使用上游模型 ID，与旧嵌入式上游的 `free/opencode/…` 命名不同。**网关 `token` 为空时客户端不需要填任何 Key**。
- 429 `Free usage limit reached` 表示当前所有出口/通道的免费额度都在窗口外，等窗口滚动即可恢复（实测同一天内多次"打满→隔一段时间又可用"）；这不是网关故障。

### 备用：嵌入式 opencode2api（驱动本机 opencode serve）

`gateway.config.json` 里保留了一条禁用的 `local-free-embedded` 上游（移植自 TiaraBasori/opencode2api v2，MIT，见 `plugin/` 内的许可副本）：驱动本机 opencode 运行时访问免费模型，账号身份沿用 `opencode auth login` 的登录态。因为它是真实 opencode 客户端，指纹检测天然通过，但单出口 IP 的免费额度没有轮换能力，打满时只能等恢复。需要时把它改回 `enabled: true` 并禁用 Go 上游即可，模型名会变回 `free/opencode/…`。

```json
{
  "id": "local-free-embedded",
  "name": "OpenCode Local (embedded opencode2api)",
  "type": "opencode2api",
  "prefix": "free",
  "baseURL": "http://127.0.0.1:10001",
  "opencodePath": "opencode",
  "manageBackend": true,
  "disableTools": true,
  "autoCleanupConversations": true,
  "enabled": false
}
```

## 环境变量

| 变量 | 覆盖 |
|:-----|:-----|
| `OPENCODE_GO_API_KEY` | OpenCode Go 预设的密钥（优先于配置文件 `apiKey`） |
| `OPENCODE_GO_GATEWAY_HOST` / `_PORT` | 监听地址 / 端口 |
| `OPENCODE_GO_GATEWAY_TOKEN` | 网关鉴权 token |
| `HTTPS_PROXY` / `HTTP_PROXY` | 上游出网代理，例如 `http://127.0.0.1:7897`；opencode CLI/后端同样读它 |
| `NO_PROXY` | 代理白名单，必须含回环（`localhost,127.0.0.1,::1`），否则网关访问本机后端也会被代理 |
| `NODE_USE_ENV_PROXY` | 让 Node 的 `fetch` 读取上面的代理变量；启动入口已设为 `1`，手动 `node src/standalone.ts` 时需自带 |

## 工作原理补充

- **思考内容桥接**：chat 上游的 `reasoning_content`（DeepSeek 风格，含 `reasoning` 变体）在 Anthropic 协议端点转换为 thinking 块（流式 `thinking_delta` / 非流式 thinking block），在 Responses 协议端点转换为 reasoning summary，让支持思考展示的客户端直接渲染。
- **内联思考剥离**：部分 Go 路由把思考以 `<think>…</think>` 标签内联在 `content` 里输出（标签可能被拆到两个增量里）；网关按增量状态机把这段内容转入 thinking 块，不再漏进正文。
- **会话与推理缓存**：DeepSeek 类模型的 `reasoning_content` 按 `x-opencode-session` 会话缓存（LRU 200），并在后续请求中回注到 messages，保证多轮推理连续性。
- **参数兼容回退**：上游对 `reasoning` / `thinking` / `effort` 等参数报 400/422 时（`paramFallback: true`），自动剥离全部推理类参数重试一次。
- **瞬断重试**：上游 429 / 5xx / 连接失败 / 首字节超时按指数退避自动重试（`retry.attempts` 次内，尊重 `Retry-After`）；鉴权、参数类永久错误首次即失败。流式响应在首字节到达前被切断会自动重放，客户端无感；开始转发后再被切断（上游掐断长连接等），以**唯一一个结构化错误帧**收尾（`code: "upstream_truncated"` + `retryable: true`），客户端可安全重跑整轮（失败轮不会写入历史，重试不会重复输出）；落在帧中间的残缺字节直接丢弃，不会发给客户端导致其解析器崩溃。
- **上游端点抖动（"Endpoint is unavailable"）**：OpenCode Go 对同一次后端不可用会随缘返回 429 / 422 / 503，响应体都是 `Upstream request failed: Endpoint is unavailable.`。按状态码分类会把 422 当成立即失败的参数错误，用户直接看到一次没重试的 422。网关改为**按响应体识别**该条件：无论状态码一律按瞬断走重试梯子（先试 `/responses` 备用协议，再退避重试）；重试预算耗尽后返回 **503 `UPSTREAM_UNAVAILABLE` + `retryable: true`**（并带上游原始原因），而不是把 422 甩给客户端。遇到时重跑整轮或换一个 Go 模型即可，额度并未扣错。
- **账户类错误快速失败**：`401` / `402` / `403`，以及响应体命中 `insufficient funds` / `free usage limit reached` / `quota exceeded` / `billing` / `not available in your country` 时，网关**不走重试梯子**，也不做 `/responses` 协议回退，立即返回 `UPSTREAM_ACCOUNT_ERROR` + `retryable: false`，并带上游原文（如 `Free usage limit reached. Subscribe to OpenCode Go`）。这类错误在一次请求内不会自愈，重试只会把客户端的整个超时耗光，最后伪装成"网关超时"。
- **账号身份优先级**：嵌入式上游只要配了 `zenApiKey` 就会注入 `OPENCODE_API_KEY`，覆盖掉 `opencode auth login` 的登录态——这会让人困惑："CLI 直接跑好好的，走网关就报额度不足"。`preferAuthFile`（默认 `true`）让 `auth.json` 里的登录态优先，网关与 CLI 行为保持一致。
- **空回复兜底**：非流式空回复按 `EMPTY_RESPONSE` 重试；Anthropic 流式在结尾若没有任何内容块，以协议级 `error` 事件收尾而不是返回"成功的空消息"，agent 可据此重跑。
- **模型列表软失败**：`/v1/models` 优先返回上次成功结果并在后台刷新；首次冷启动最多等 8 秒（后端 provider 列表可能更慢），不会把“后端暂时不可用”当成真实目录缓存 10 分钟，也不会再用单个兜底模型冒充完整列表。

## 开发与测试

零依赖，直接用 Node 原生类型剥离运行；测试同样：

```bash
node --test          # 全部测试（协议转换、重试梯子、流截断、参数回退、本地后端自愈）
```

本地后端的测试使用假 `opencode` 二进制（.cmd 包一个小 HTTP 服务器），不需要真实 opencode 安装。

> 测试会读取仓库根的 `gateway.config.json`。测试用例显式传 `token: ""` 关闭鉴权，因此配置里设了 `token` 也不会导致 401；但**网关不会**在"空 token + 非回环地址"下启动，配置成那样时相关用例会抛 `TOKEN_REQUIRED`。

## 故障排查

| 现象 | 原因与处理 |
|:-----|:-----|
| `Port 8787 is already in use` | 已有实例在跑。换 `port`，或按端口找到 PID 结束：`netstat -ano \| findstr :8787` |
| 启动即报语法/加载错误 | Node 版本低于 22.6，无法原生运行 `.ts`。升级 Node 或改用高版本完整路径 |
| 上游 401 | `apiKey` 与上游不匹配 |
| 上游报 `Insufficient account funds` | 账号额度不足（如免费档调付费模型），与网关无关。网关现在会**立即**返回 `UPSTREAM_ACCOUNT_ERROR`（不再重试到客户端超时） |
| 走网关报额度不足，但 `opencode` CLI 直接跑正常 | 配置里的 `zenApiKey` 顶掉了 `auth.json` 的登录态。清空 `zenApiKey`，或保持 `preferAuthFile: true`（默认）。网关日志会打印 `auth.json is present; ignoring configured zenApiKey` |
| 一直卡到客户端超时、拿不到任何报错 | 先看是不是被重试放大的永久错误：查 `gateway.err.log` 与 opencode 日志（`~/.local/share/opencode/log/opencode.log`）里的 `AI_APICallError`。另外确认后端没卡在 `bootstrapping`：健康的 `/global/health` 不代表业务接口可用，`curl http://127.0.0.1:10001/session` 应在数百毫秒内返回 |
| 后端反复 `bootstrapping`、每次约 70 秒 | opencode 在等一次必然失败的依赖安装。检查 `~/.npmrc` 的 `registry`——`registry.npm.taobao.org` 的证书已过期，换成 `https://registry.npmmirror.com/` 后重启后端 |
| 无 Key 访问 `/v1` 返回 `401 Invalid gateway token` | 配置里 `token` 非空。想免鉴权就把 `token` 设为 `""`（`hostname` 必须是回环） |
| 启动报 `TOKEN_REQUIRED` | `token` 为空却监听在非回环地址。设 `token`，或把 `hostname` 改回 `127.0.0.1` |
| `/v1/responses` 返回 501 | 目标模型未声明 responses 协议；给上游加 `responsesPrefixes` 或 `responsesModels`（嵌入式上游无需，原生支持） |
| `/v1/models` 为空或缺上游 | `baseURL` 需含版本段（以 `/v1` 结尾）；检查上游是否 `enabled` 且可达 |
| DSH 插件刷新报“端点没有返回任何模型” | 插件 Go 卡只认 `go/` 前缀：确认 `opencode-go` upstream 已启用且 `prefix` 为 `go`、`apiKey` 不是占位符，且 `~/.dsh/.env` 里有 `OPENCODE_GATEWAY_KEY=<网关 token>`。详见上文「与 DSH 插件对接」 |
| DSH 插件刷新报 `HTTP 401` | 网关 `token` 与 `~/.dsh/.env` 的 `OPENCODE_GATEWAY_KEY` 不一致；改完重启 DSH |
| 聊天报 `403 An active OpenCode Go subscription is required` | `opencode-go` upstream 用的 `apiKey` 没有 Go 订阅。删掉该 `apiKey` 改用本机 `opencode auth login` 登录态，或换成已订阅的 Key，然后重启网关 |
| 聊天报 `422` / `429` `Upstream request failed: Endpoint is unavailable.` | OpenCode Go 服务端该模型的路由暂时不可用（不是你的配置、网络或额度问题；同一 Key 换个模型往往立刻可用）。新版网关会识别并重试，预算耗尽后转为 `503 UPSTREAM_UNAVAILABLE`；过几秒重跑整轮或换模型即可。可用 `curl` 直连 `https://opencode.ai/zen/go/v1/chat/completions` 复现/排除网关因素 |
| DSH 聊天报 `Connection error.` | 网关进程没在跑（8787 无监听），不是 Key 问题。`curl http://127.0.0.1:8787/health` 应返回 `{"status":"ok"}`；没返回就通过托盘或 `start-tray-hidden.vbs` 重新拉起 |
| DSH 插件第一次刷新为空、第二次正常 | 网关冷启动：`/v1/models` 先返回上次结果（无缓存时最多等 8 秒），后台继续读取本机后端，完成后下一次刷新即完整 |
| 嵌入式上游首个请求很慢（10~20 秒） | opencode 实例首次初始化，属正常现象；之后恢复毫秒级 |
| 嵌入式上游报 `Cannot connect to API` | 后端访问不了 Zen。检查 `HTTPS_PROXY` 等代理环境变量：代理客户端没跑就清空它们走直连，代理在跑就确认端口可达 |
| 嵌入式上游报 `500 {"message":"fetch failed"}`、反复"重连" | 本地 `opencode serve` 后端进程死了。`netstat -ano \| findstr :10001` 无 LISTENING 即确认。新版网关会在下个请求自动重新拉起后端（并记录退出码到日志）；旧版需重启网关 |
| 流式回合报 `upstream_truncated` | 上游掐断了长连接（代理或服务端行为），网关已丢弃残缺帧并以带 `retryable` 的结构化错误帧收尾；客户端重跑整轮即可 |
| 报 `self signed certificate` / `Unable to connect` / 网关 502 `Upstream connection failed` | 本机到 `opencode.ai` 的直连被 DNS 污染或劫持。确认代理在跑且 `HTTPS_PROXY`、`NODE_USE_ENV_PROXY` 已生效（改完环境变量要重启网关与终端；`netstat -ano \| findstr 7897` 能看到网关/后端连着代理端口即为生效） |
| opencode CLI 本身报同样的 `Cannot connect to API` | 同因：CLI 不读系统代理，只认 `HTTPS_PROXY` 环境变量。`setx HTTPS_PROXY http://127.0.0.1:7897` 后重开终端 |
