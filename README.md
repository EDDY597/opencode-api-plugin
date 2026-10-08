# opencode-api-plugin

本地多协议 LLM 网关 —— 一个端点聚合多个上游，自动在 **Chat Completions / Anthropic Messages / Responses** 三种协议之间转换。

内置 **opencode2api 嵌入式上游**：驱动本机 opencode 运行时，把 OpenCode Zen 免费模型变成网关的一个上游，单进程、零依赖、无需安装独立的 opencode2api 服务。

零依赖（仅用 Node 内置模块，无需 `npm install`），Windows 友好（脚本启动 + 系统托盘）。

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

## 快速开始

```bash
# 1. 准备配置
cp gateway.config.example.json gateway.config.json
#    编辑 gateway.config.json：设置 token，填上游的 apiKey

# 2. 启动
start-gateway.cmd              # 前台窗口，可看日志
start-gateway-hidden.vbs       # 静默后台运行
tray\tray.cmd                  # 托盘模式（推荐）：托盘启动并托管网关

# 3. 验证
curl -H "Authorization: Bearer <token>" http://127.0.0.1:8787/v1/models
```

## 系统托盘

`tray\tray.ps1`（经 `tray.cmd` / `tray-hidden.vbs` 启动）是网关的托盘管家，**图标存在 = 网关进程在运行**：

- 启动时若网关未运行则自动拉起（隐藏窗口）；已运行则直接接管
- 托盘**绿色**图标 = 网关健康；**灰色** = 启动中/异常
- **悬停**显示 OpenCode 额度：5h / 周 / 月窗口的剩余百分比与重置时间（需 Go 订阅权益，未订阅显示对应提示）；每 60 秒刷新
- **右键菜单**：
  - **重启服务** —— 杀掉网关进程树并重新拉起（改完 gateway.config.json 后用它生效）
  - **设置...** —— 弹窗编辑嵌入式上游的常用参数：OpenCode API Key（Zen 密钥，同时用于后端付费模型与额度查询）、opencode 可执行文件路径、调试日志开关；保存后自动重启生效
  - **退出** —— 停止网关并关闭托盘
- 网关进程退出（崩溃/被杀）时托盘弹出气泡提示并自动关闭，图标不会谎报状态

注意：托盘与网关是同生关系——关托盘即停网关。想让网关脱离托盘常驻，用 `start-gateway-hidden.vbs` 启动即可（此时托盘只做监控与显示）。

## 配置参考

顶层字段（均可被环境变量覆盖，见下文）：

| 字段 | 默认 | 说明 |
|:-----|:-----|:-----|
| `hostname` | `127.0.0.1` | 监听地址 |
| `port` | `8787` | 监听端口 |
| `token` | (空) | 网关自身的 Bearer 鉴权；设置后所有 `/v1/*` 请求必须携带 |
| `upstreams` | 内置 OpenCode Go 预设 | 上游列表，见下表 |

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
| `zenApiKey` | (空) | 透传为后端的 `OPENCODE_API_KEY`（解锁付费模型） |
| `disableTools` | `true` | 禁用 OpenCode 内置工具（经 tool-lock 插件执行，免费档必需） |
| `internalAllowedTools` | (空) | 内置工具白名单（逗号分隔或数组） |
| `promptMode` | `standard` | `standard` 或 `plugin-inject` |
| `omitSystemPrompt` | `false` | 忽略客户端传入的 system prompt |
| `requestTimeoutMs` | `300000` | 单次请求超时（含上游重试） |
| `useIsolatedHome` | `false` | Unix 下使用隔离 fake-home（Windows 恒用真实用户目录） |
| `autoCleanupConversations` | `false` | 定期清理会话存储 |
| `eventIdleTimeoutMs` / `eventFirstDeltaTimeoutMs` | `8000` / `30000` | 事件流空闲/首包超时 |
| `debug` | `false` | 调试日志 |

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

## 实战：免费模型（嵌入式 opencode2api）

内置的嵌入式上游移植自 [opencode2api](https://github.com/TiaraBasori/opencode2api)（MIT，见 `plugin/` 内的许可副本）：驱动本机 opencode 运行时访问 OpenCode Zen 免费模型，无需单独安装或启动任何其他服务。前置条件只有一个——本机装有 opencode CLI（`npm install -g opencode-ai`），建议先 `opencode auth login` 登录免费账号（模型列表与限额都更好，匿名也能用）。

`gateway.config.json`：

```json
{
  "id": "local-free",
  "name": "OpenCode Local (embedded opencode2api)",
  "type": "opencode2api",
  "prefix": "free",
  "baseURL": "http://127.0.0.1:10001",
  "opencodePath": "opencode",
  "manageBackend": true,
  "disableTools": true,
  "autoCleanupConversations": true,
  "enabled": true
}
```

- 首次请求后端会自动拉起（实例初始化约 10~20 秒，之后恢复毫秒级）；网关退出时自动关闭后端。
- 客户端接入：地址 `http://127.0.0.1:8787/v1`，密钥为网关 `token`，模型名如 `free/opencode/space-bunny-free`。
- 三种协议端点 + 流式均已实测打通；仅免费档模型可用，付费模型会由上游报 `Insufficient account funds`。
- 若后端无法访问 Zen，先确认本机代理环境变量（`HTTPS_PROXY` 等）指向的代理客户端正在运行，或将其清空走直连。

也可改为传统部署：单独运行 opencode2api 服务，然后用 `type: "openai"` + `baseURL` 指向它，效果等同。

## 环境变量

| 变量 | 覆盖 |
|:-----|:-----|
| `OPENCODE_GO_API_KEY` | OpenCode Go 预设的密钥（优先于配置文件 `apiKey`） |
| `OPENCODE_GO_GATEWAY_HOST` / `_PORT` | 监听地址 / 端口 |
| `OPENCODE_GO_GATEWAY_TOKEN` | 网关鉴权 token |

## 工作原理补充

- **思考内容桥接**：chat 上游的 `reasoning_content`（DeepSeek 风格，含 `reasoning` 变体）在 Anthropic 协议端点转换为 thinking 块（流式 `thinking_delta` / 非流式 thinking block），在 Responses 协议端点转换为 reasoning summary，让支持思考展示的客户端直接渲染。
- **内联思考剥离**：部分 Go 路由把思考以 `<think>…</think>` 标签内联在 `content` 里输出（标签可能被拆到两个增量里）；网关按增量状态机把这段内容转入 thinking 块，不再漏进正文。
- **会话与推理缓存**：DeepSeek 类模型的 `reasoning_content` 按 `x-opencode-session` 会话缓存（LRU 200），并在后续请求中回注到 messages，保证多轮推理连续性。
- **参数兼容回退**：上游对 `reasoning` / `thinking` / `effort` 等参数报 400/422 时（`paramFallback: true`），自动剥离全部推理类参数重试一次。
- **瞬断重试**：上游 429 / 5xx / 连接失败 / 首字节超时按指数退避自动重试（`retry.attempts` 次内，尊重 `Retry-After`）；鉴权、参数类永久错误首次即失败。流式响应一旦开始向客户端转发就不再重试（避免输出重复），断流错误由客户端的 agent 层重跑整个请求。
- **空回复兜底**：非流式空回复按 `EMPTY_RESPONSE` 重试；Anthropic 流式在结尾若没有任何内容块，以协议级 `error` 事件收尾而不是返回"成功的空消息"，agent 可据此重跑。

## 故障排查

| 现象 | 原因与处理 |
|:-----|:-----|
| `Port 8787 is already in use` | 已有实例在跑。换 `port`，或按端口找到 PID 结束：`netstat -ano \| findstr :8787` |
| 启动即报语法/加载错误 | Node 版本低于 22.6，无法原生运行 `.ts`。升级 Node 或改用高版本完整路径 |
| 上游 401 | `apiKey` 与上游不匹配 |
| 上游报 `Insufficient account funds` | 账号额度不足（如免费档调付费模型），与网关无关 |
| `/v1/responses` 返回 501 | 目标模型未声明 responses 协议；给上游加 `responsesPrefixes` 或 `responsesModels`（嵌入式上游无需，原生支持） |
| `/v1/models` 为空或缺上游 | `baseURL` 需含版本段（以 `/v1` 结尾）；检查上游是否 `enabled` 且可达 |
| 嵌入式上游首个请求很慢（10~20 秒） | opencode 实例首次初始化，属正常现象；之后恢复毫秒级 |
| 嵌入式上游报 `Cannot connect to API` | 后端访问不了 Zen。检查 `HTTPS_PROXY` 等代理环境变量：代理客户端没跑就清空它们走直连，代理在跑就确认端口可达 |
