# opencode-api-plugin

本地多协议 LLM 网关 —— 一个端点聚合多个上游，自动在 **Chat Completions / Anthropic Messages / Responses** 三种协议之间转换。

零依赖（仅用 Node 内置模块，无需 `npm install`），Windows 友好（脚本启动 + 系统托盘）。

## 解决什么问题

- 客户端各说各话：有的只发 OpenAI Chat Completions，有的只发 Anthropic Messages（如 Claude Code 类工具），有的用 Responses API。网关在入口做协议转换，任何客户端都能接任何上游。
- 上游各说各话：OpenCode Go 官方端点、OpenCode Zen、本地代理（如 [opencode2api](https://github.com/TiaraBasori/opencode2api)）、第三方 OpenAI 兼容服务，统一聚合到 `http://127.0.0.1:8787/v1`。
- 模型名冲突：不同上游可能有同名模型。用 `前缀/模型名` 路由，前缀自动剥离后转发。

```
客户端（任意协议）
   │  /v1/chat/completions │ /v1/messages │ /v1/responses
   ▼
网关 127.0.0.1:8787        ← 本项目
   │  按模型名前缀路由 + 协议转换
   ├──► OpenCode Go（官方预设，读取本地 opencode 登录态）
   ├──► OpenCode Zen（官方 API，配 API Key）
   └──► 任意 OpenAI 兼容上游（自定义 baseURL，如本地 opencode2api）
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
tray.cmd                       # 另加一个系统托盘图标（悬停显示额度，右键刷新/退出）

# 3. 验证
curl -H "Authorization: Bearer <token>" http://127.0.0.1:8787/v1/models
```

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
| `apiKey` | 发给上游的密钥；`opencode-go` 预设可省略（自动读本地 opencode 凭据） |
| `protocol` | 该上游的默认协议：`openai`（默认）/ `anthropic` / `responses` |
| `responsesPrefixes` / `anthropicPrefixes` | 按模型名前缀强制指定协议，优先于 `protocol` |
| `responsesModels` / `anthropicModels` / `protocols` | 按精确模型名指定协议（`protocols` 是 `模型名: 协议` 映射） |
| `models` | 模型白名单（数组或对象），限制 `/v1/models` 聚合与可转发范围 |
| `authHeader` | 上游鉴权方式：`bearer`（默认）/ `x-api-key` / `both` |
| `headers` | 附加到每个上游请求的自定义头 |
| `sessionHeader` | `true` 时向上游透传 `x-opencode-session` 会话头 |
| `modelParams` | 按模型强制覆盖请求参数（如 `{"模型名": {"temperature": 0}}`） |
| `reasoningEffortMap` | `reasoning_effort` 值重映射（如 `{"high":"medium"}`） |
| `stripParams` | 转发前从请求体删除的参数名 |
| `paramFallback` | 默认 `true`：上游返回 400/422 且疑似不支持推理类参数时，剥离这些参数自动重试一次 |
| `usageBase` / `usage` | `/api/usage` 额度聚合的上游地址；`usage: false` 排除该上游 |
| `enabled` | 开关，默认 `true` |

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

## 实战：聚合本地 opencode2api 免费模型

[opencode2api](https://github.com/TiaraBasori/opencode2api) 把本机 opencode 运行时变成 OpenAI 兼容端点（免费模型），配合本网关即可让 **Anthropic 协议客户端**（Claude Code 类）也能用上这些模型：

```json
{
  "id": "opencode2api",
  "name": "Local Free (opencode2api)",
  "type": "openai",
  "prefix": "free",
  "baseURL": "http://127.0.0.1:10000/v1",
  "apiKey": "<opencode2api 的 API_KEY>",
  "protocol": "openai",
  "responsesPrefixes": ["opencode/"],
  "paramFallback": true,
  "enabled": true
}
```

- `responsesPrefixes: ["opencode/"]`：该上游所有模型（剥离前缀后均以 `opencode/` 开头）视为支持 Responses API。网关的 Chat/Anthropic 请求也会经 Responses 协议转换转发，实测全链路可用。
- 客户端接入：地址 `http://127.0.0.1:8787/v1`，密钥为网关 `token`，模型名如 `free/opencode/space-bunny-free`。
- 三种协议端点均已实测打通（含流式）；仅免费档模型可用，付费模型会由上游报 `Insufficient account funds`。

## 环境变量

| 变量 | 覆盖 |
|:-----|:-----|
| `OPENCODE_GO_API_KEY` | OpenCode Go 预设的密钥（优先于配置文件 `apiKey`） |
| `OPENCODE_GO_GATEWAY_HOST` / `_PORT` | 监听地址 / 端口 |
| `OPENCODE_GO_GATEWAY_TOKEN` | 网关鉴权 token |

## 工作原理补充

- **会话与推理缓存**：DeepSeek 类模型的 `reasoning_content` 按 `x-opencode-session` 会话缓存（LRU 200），并在后续请求中回注到 messages，保证多轮推理连续性。
- **参数兼容回退**：上游对 `reasoning` / `thinking` / `effort` 等参数报 400/422 时（`paramFallback: true`），自动剥离全部推理类参数重试一次。

## 故障排查

| 现象 | 原因与处理 |
|:-----|:-----|
| `Port 8787 is already in use` | 已有实例在跑。换 `port`，或按端口找到 PID 结束：`netstat -ano \| findstr :8787` |
| 启动即报语法/加载错误 | Node 版本低于 22.6，无法原生运行 `.ts`。升级 Node 或改用高版本完整路径 |
| 上游 401 | `apiKey` 与上游不匹配 |
| 上游报 `Insufficient account funds` | 账号额度不足（如免费档调付费模型），与网关无关 |
| `/v1/responses` 返回 501 | 目标模型未声明 responses 协议；给上游加 `responsesPrefixes` 或 `responsesModels` |
| `/v1/models` 为空或缺上游 | `baseURL` 需含版本段（以 `/v1` 结尾）；检查上游是否 `enabled` 且可达 |
