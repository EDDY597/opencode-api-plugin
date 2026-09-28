import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const GO_BASE = "https://opencode.ai/zen/go/v1"
export const VERSION = "0.1.0"
const USER_AGENT = `opencode-go-gateway/${VERSION}`
const DEFAULT_PORT = 8787
const MODELS_TTL_MS = 10 * 60 * 1000

export const RESPONSES_MODELS = new Set<string>([
  "grok-4.5",
  "grok-4.6",
  "grok-4.7",
  "gpt-5.6-luna",
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor",
])

export const FALLBACK_MODELS = [
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "longcat-2.0",
  "glm-5.3-flash",
  "glm-5.3",
  "glm-5.2",
  "glm-5.1",
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "hy4-preview",
  "hy3",
  "grok-4.6",
  "gpt-5.6-luna",
]

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" }

function randomId(prefix: string) {
  return `${prefix}${randomUUID().replace(/-/g, "")}`
}

function textOfContent(content: any): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && part.type === "text") return part.text || ""
        return ""
      })
      .join("")
  }
  return ""
}

export function toChatUsage(usage: any) {
  if (!usage) return undefined
  const prompt = usage.input_tokens ?? usage.prompt_tokens ?? 0
  const completion = usage.output_tokens ?? usage.completion_tokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.total_tokens ?? prompt + completion,
    prompt_tokens_details: { cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0 },
  }
}

function normalizeInputContent(content: any, role: string) {
  if (typeof content === "string" || content == null) return content ?? ""
  if (!Array.isArray(content)) return content
  return content.map((part: any) => {
    if (!part || typeof part !== "object") return part
    if (part.type === "text") {
      return { type: role === "assistant" ? "output_text" : "input_text", text: part.text ?? "" }
    }
    if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
      return { type: "input_image", image_url: url }
    }
    return part
  })
}

function chatToolsToResponses(tools: any[]) {
  return tools.map((tool: any) => {
    if (tool.type && tool.type !== "function") return tool
    const fn = tool.function ?? tool
    return {
      type: "function",
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters ?? { type: "object", properties: {} },
    }
  })
}

function chatToolChoiceToResponses(choice: any) {
  if (choice == null) return undefined
  if (typeof choice === "string") return choice
  if (choice.type === "function") return { type: "function", name: choice.function?.name }
  return choice
}

export function chatToResponses(body: any) {
  const input: any[] = []
  for (const message of body.messages ?? []) {
    const role = message.role
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
      })
      continue
    }
    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      if (typeof message.content === "string" && message.content) {
        input.push({ role: "assistant", content: message.content })
      }
      for (const call of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments ?? "",
        })
      }
      continue
    }
    input.push({
      role: role === "developer" ? "system" : role,
      content: normalizeInputContent(message.content, role),
    })
  }

  const payload: any = { model: body.model, input }
  if (Array.isArray(body.tools) && body.tools.length) payload.tools = chatToolsToResponses(body.tools)
  const toolChoice = chatToolChoiceToResponses(body.tool_choice)
  if (toolChoice !== undefined) payload.tool_choice = toolChoice
  if (body.temperature != null) payload.temperature = body.temperature
  if (body.top_p != null) payload.top_p = body.top_p
  const max = body.max_completion_tokens ?? body.max_tokens
  if (max != null) payload.max_output_tokens = max
  if (body.stream) payload.stream = true
  return payload
}

export function responsesToChat(json: any, model: string) {
  const output = Array.isArray(json.output) ? json.output : []
  let text = ""
  let reasoning = ""
  const toolCalls: any[] = []
  for (const item of output) {
    if (!item) continue
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part?.type === "output_text") text += part.text ?? ""
      }
    } else if (item.type === "reasoning") {
      for (const part of item.summary ?? []) {
        if (part?.type === "summary_text") reasoning += part.text ?? ""
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id,
        type: "function",
        function: { name: item.name, arguments: item.arguments ?? "" },
      })
    }
  }

  const message: any = { role: "assistant", content: text || null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) message.tool_calls = toolCalls
  const finish = toolCalls.length
    ? "tool_calls"
    : json.status === "incomplete" && json.incomplete_details?.reason === "max_output_tokens"
      ? "length"
      : "stop"

  return {
    id: json.id ?? randomId("chatcmpl-"),
    object: "chat.completion",
    created: json.created_at || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish, logprobs: null }],
    usage: toChatUsage(json.usage),
  }
}

type SseEvent = { event?: string; data: string }

export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf("\n\n")
    while (index !== -1) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      yield parseSseBlock(block)
      index = buffer.indexOf("\n\n")
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) yield parseSseBlock(buffer)
}

function parseSseBlock(block: string): SseEvent {
  const normalized = block.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  let event: string | undefined
  const data: string[] = []
  for (const line of normalized.split("\n")) {
    if (!line || line.startsWith(":")) continue
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
  }
  return { event, data: data.join("\n") }
}

function frame(payload: string) {
  return `data: ${payload}\n\n`
}

function eventFrame(event: string, payload: any) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

export function streamFromAsync(generator: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await generator.next()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(value))
      } catch (error) {
        controller.error(error)
      }
    },
  })
}

export async function* responsesStreamToChat(
  stream: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<string> {
  let id = randomId("chatcmpl-")
  const created = Math.floor(Date.now() / 1000)
  let roleSent = false
  let hadToolCall = false
  let finishReason = "stop"
  let usage: any
  const toolIndexByOutput = new Map<number, number>()
  let toolCount = 0
  let ended = false

  const makeChunk = (delta: any, finish: string | null = null) =>
    frame(
      JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
      }),
    )

  for await (const ev of sseEvents(stream)) {
    if (!ev.data || ev.data === "[DONE]") continue
    let payload: any
    try {
      payload = JSON.parse(ev.data)
    } catch {
      continue
    }
    const type = payload.type ?? ev.event
    const frames: string[] = []

    if (type === "response.created" || type === "response.in_progress") {
      if (payload.response?.id) id = payload.response.id
      continue
    }
    if (type === "response.output_item.added") {
      const item = payload.item
      if (item?.type === "function_call") {
        if (!roleSent) {
          roleSent = true
          frames.push(makeChunk({ role: "assistant", content: "" }))
        }
        const index = toolCount++
        toolIndexByOutput.set(payload.output_index, index)
        hadToolCall = true
        frames.push(
          makeChunk({
            tool_calls: [
              {
                index,
                id: item.call_id ?? item.id,
                type: "function",
                function: { name: item.name, arguments: "" },
              },
            ],
          }),
        )
      }
    } else if (type === "response.output_text.delta") {
      if (!roleSent) {
        roleSent = true
        frames.push(makeChunk({ role: "assistant", content: "" }))
      }
      frames.push(makeChunk({ content: payload.delta ?? "" }))
    } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      if (!roleSent) {
        roleSent = true
        frames.push(makeChunk({ role: "assistant", content: "" }))
      }
      frames.push(makeChunk({ reasoning_content: payload.delta ?? "" }))
    } else if (type === "response.function_call_arguments.delta") {
      const index = toolIndexByOutput.get(payload.output_index) ?? 0
      frames.push(makeChunk({ tool_calls: [{ index, function: { arguments: payload.delta ?? "" } }] }))
    } else if (type === "response.completed") {
      const response = payload.response ?? {}
      usage = toChatUsage(response.usage)
      if (hadToolCall) finishReason = "tool_calls"
      else if (response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens")
        finishReason = "length"
      ended = true
    } else if (type === "response.failed" || type === "response.error" || type === "error") {
      finishReason = "stop"
      ended = true
    }

    for (const f of frames) yield f

    if (ended) {
      yield frame(
        JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason, logprobs: null }],
          usage: usage ?? null,
        }),
      )
      yield frame("[DONE]")
      return
    }
  }

  yield frame(
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason, logprobs: null }],
      usage: usage ?? null,
    }),
  )
  yield frame("[DONE]")
}

export function anthropicToChat(body: any) {
  const messages: any[] = []
  if (body.system) {
    messages.push({ role: "system", content: textOfContent(body.system) })
  }
  for (const message of body.messages ?? []) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content })
      continue
    }
    const blocks = Array.isArray(message.content) ? message.content : []
    if (message.role === "assistant") {
      let text = ""
      const toolCalls: any[] = []
      for (const block of blocks) {
        if (block?.type === "text") text += block.text ?? ""
        else if (block?.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          })
        }
      }
      const converted: any = { role: "assistant", content: text || null }
      if (toolCalls.length) converted.tool_calls = toolCalls
      messages.push(converted)
    } else {
      const parts: any[] = []
      const toolResults: any[] = []
      for (const block of blocks) {
        if (block?.type === "text") parts.push({ type: "text", text: block.text ?? "" })
        else if (block?.type === "image") {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${block.source?.media_type};base64,${block.source?.data}` },
          })
        } else if (block?.type === "tool_result") toolResults.push(block)
      }
      if (parts.length) {
        messages.push({
          role: "user",
          content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
        })
      }
      for (const result of toolResults) {
        messages.push({ role: "tool", tool_call_id: result.tool_use_id, content: textOfContent(result.content) })
      }
    }
  }

  const out: any = { model: body.model, messages }
  if (body.max_tokens != null) out.max_tokens = body.max_tokens
  if (body.temperature != null) out.temperature = body.temperature
  if (body.top_p != null) out.top_p = body.top_p
  if (body.stop_sequences) out.stop = body.stop_sequences
  if (body.stream) out.stream = true
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((tool: any) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
    }))
  }
  if (body.tool_choice) {
    if (body.tool_choice.type === "auto") out.tool_choice = "auto"
    else if (body.tool_choice.type === "any") out.tool_choice = "required"
    else if (body.tool_choice.type === "none") out.tool_choice = "none"
    else if (body.tool_choice.type === "tool")
      out.tool_choice = { type: "function", function: { name: body.tool_choice.name } }
  }
  return out
}

function mapStopReason(finish: string | null | undefined) {
  if (finish === "tool_calls") return "tool_use"
  if (finish === "length") return "max_tokens"
  if (finish === "content_filter") return "stop_sequence"
  return "end_turn"
}

export function chatToAnthropic(json: any, model: string) {
  const choice = json.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const content: any[] = []
  if (message.content) content.push({ type: "text", text: message.content })
  for (const call of message.tool_calls ?? []) {
    let input: any = {}
    try {
      input = JSON.parse(call.function?.arguments || "{}")
    } catch {
      input = {}
    }
    content.push({ type: "tool_use", id: call.id, name: call.function?.name, input })
  }
  if (!content.length) content.push({ type: "text", text: "" })
  return {
    id: json.id?.startsWith("msg_") ? json.id : `msg_${json.id ?? randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: json.usage?.prompt_tokens ?? 0,
      output_tokens: json.usage?.completion_tokens ?? 0,
    },
  }
}

export async function* chatStreamToAnthropic(
  stream: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<string> {
  const id = randomId("msg_")
  yield eventFrame("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  const order: { key: string; index: number }[] = []
  const indexByKey = new Map<string, number>()
  let nextIndex = 0
  let stopReason = "end_turn"
  let outputTokens = 0
  let closed = false

  const openBlock = (key: string, block: any) => {
    if (indexByKey.has(key)) return indexByKey.get(key)!
    const index = nextIndex++
    indexByKey.set(key, index)
    order.push({ key, index })
    return index
  }

  const closeAll = () => {
    if (closed) return [] as string[]
    closed = true
    return order.map((entry) => eventFrame("content_block_stop", { type: "content_block_stop", index: entry.index }))
  }

  for await (const ev of sseEvents(stream)) {
    if (!ev.data || ev.data === "[DONE]") continue
    let payload: any
    try {
      payload = JSON.parse(ev.data)
    } catch {
      continue
    }
    if (payload.error) {
      yield eventFrame("error", { type: "error", error: payload.error })
      return
    }
    if (payload.usage?.completion_tokens != null) outputTokens = payload.usage.completion_tokens
    else if (payload.usage?.output_tokens != null) outputTokens = payload.usage.output_tokens

    const choice = payload.choices?.[0] ?? {}
    const delta = choice.delta ?? {}
    const frames: string[] = []

    if (typeof delta.content === "string" && delta.content) {
      const isNew = !indexByKey.has("text")
      const index = openBlock("text", { type: "text" })
      if (isNew) {
        frames.push(
          eventFrame("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          }),
        )
      }
      frames.push(
        eventFrame("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: delta.content },
        }),
      )
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const key = `tool:${call.index ?? 0}`
        const isNew = !indexByKey.has(key)
        const index = openBlock(key, { type: "tool_use" })
        if (isNew) {
          frames.push(
            eventFrame("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "tool_use", id: call.id, name: call.function?.name, input: {} },
            }),
          )
        }
        if (call.function?.arguments) {
          frames.push(
            eventFrame("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: call.function.arguments },
            }),
          )
        }
      }
    }

    let finished = false
    if (choice.finish_reason) {
      stopReason = mapStopReason(choice.finish_reason)
      frames.push(...closeAll())
      frames.push(
        eventFrame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        }),
      )
      frames.push(eventFrame("message_stop", { type: "message_stop" }))
      finished = true
    }

    for (const f of frames) yield f
    if (finished) return
  }

  yield* closeAll()
  yield eventFrame("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  })
  yield eventFrame("message_stop", { type: "message_stop" })
}

export function chatToAnthropicRequest(body: any) {
  const systemParts: string[] = []
  const messages: any[] = []
  let pendingToolResults: any[] = []

  const flushToolResults = () => {
    if (pendingToolResults.length) {
      messages.push({ role: "user", content: pendingToolResults })
      pendingToolResults = []
    }
  }

  for (const message of body.messages ?? []) {
    if (message.role === "system" || message.role === "developer") {
      const text = textOfContent(message.content)
      if (text) systemParts.push(text)
      continue
    }
    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: typeof message.content === "string" ? message.content : textOfContent(message.content),
      })
      continue
    }
    flushToolResults()
    if (message.role === "assistant") {
      const blocks: any[] = []
      const text = textOfContent(message.content)
      if (text) blocks.push({ type: "text", text })
      for (const call of message.tool_calls ?? []) {
        let input: any = {}
        try {
          input = JSON.parse(call.function?.arguments || "{}")
        } catch {
          input = {}
        }
        blocks.push({ type: "tool_use", id: call.id, name: call.function?.name, input })
      }
      messages.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] })
      continue
    }
    if (typeof message.content === "string") {
      messages.push({ role: "user", content: message.content })
      continue
    }
    const blocks: any[] = []
    for (const part of message.content ?? []) {
      if (part?.type === "text") blocks.push({ type: "text", text: part.text ?? "" })
      else if (part?.type === "image_url") {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
        const match = typeof url === "string" ? /^data:(.+?);base64,(.*)$/.exec(url) : null
        if (match) blocks.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } })
        else if (url) blocks.push({ type: "image", source: { type: "url", url } })
      }
    }
    messages.push({ role: "user", content: blocks.length ? blocks : [{ type: "text", text: "" }] })
  }
  flushToolResults()

  const out: any = {
    model: body.model,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 8192,
    messages,
  }
  if (systemParts.length) out.system = systemParts.join("\n\n")
  if (body.temperature != null) out.temperature = body.temperature
  if (body.top_p != null) out.top_p = body.top_p
  if (body.stop != null) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop]
  if (body.stream) out.stream = true
  if (Array.isArray(body.tools) && body.tools.length && body.tool_choice !== "none") {
    out.tools = body.tools.map((tool: any) => ({
      name: tool.function?.name ?? tool.name,
      description: tool.function?.description ?? tool.description,
      input_schema: tool.function?.parameters ?? tool.input_schema ?? { type: "object", properties: {} },
    }))
    const choice = body.tool_choice
    if (choice === "required") out.tool_choice = { type: "any" }
    else if (choice?.type === "function") out.tool_choice = { type: "tool", name: choice.function?.name }
  }
  return out
}

export function anthropicToChatResponse(json: any, model: string) {
  let text = ""
  let reasoning = ""
  const toolCalls: any[] = []
  for (const block of json.content ?? []) {
    if (block?.type === "text") text += block.text ?? ""
    else if (block?.type === "thinking") reasoning += block.thinking ?? ""
    else if (block?.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      })
    }
  }
  const message: any = { role: "assistant", content: text || null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) message.tool_calls = toolCalls
  const finish =
    json.stop_reason === "tool_use" ? "tool_calls" : json.stop_reason === "max_tokens" ? "length" : "stop"
  const prompt = json.usage?.input_tokens ?? 0
  const completion = json.usage?.output_tokens ?? 0
  return {
    id: json.id ?? randomId("chatcmpl-"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish, logprobs: null }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  }
}

export async function* anthropicStreamToChat(
  stream: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<string> {
  const id = randomId("chatcmpl-")
  const created = Math.floor(Date.now() / 1000)
  let roleSent = false
  let finishReason = "stop"
  let usage: any
  let toolCount = 0
  const toolIndexByBlock = new Map<number, number>()

  const makeChunk = (delta: any, finish: string | null = null) =>
    frame(
      JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
      }),
    )

  for await (const ev of sseEvents(stream)) {
    if (!ev.data) continue
    let payload: any
    try {
      payload = JSON.parse(ev.data)
    } catch {
      continue
    }
    const frames: string[] = []

    if (payload.type === "message_start") {
      usage = {
        prompt_tokens: payload.message?.usage?.input_tokens ?? 0,
        completion_tokens: 0,
        total_tokens: 0,
      }
      continue
    }
    if (payload.type === "content_block_start") {
      if (!roleSent) {
        roleSent = true
        frames.push(makeChunk({ role: "assistant", content: "" }))
      }
      const block = payload.content_block
      if (block?.type === "tool_use") {
        const index = toolCount++
        toolIndexByBlock.set(payload.index, index)
        frames.push(
          makeChunk({
            tool_calls: [{ index, id: block.id, type: "function", function: { name: block.name, arguments: "" } }],
          }),
        )
      }
    } else if (payload.type === "content_block_delta") {
      if (!roleSent) {
        roleSent = true
        frames.push(makeChunk({ role: "assistant", content: "" }))
      }
      const delta = payload.delta
      if (delta?.type === "text_delta") frames.push(makeChunk({ content: delta.text ?? "" }))
      else if (delta?.type === "thinking_delta") frames.push(makeChunk({ reasoning_content: delta.thinking ?? "" }))
      else if (delta?.type === "input_json_delta") {
        const index = toolIndexByBlock.get(payload.index) ?? 0
        frames.push(makeChunk({ tool_calls: [{ index, function: { arguments: delta.partial_json ?? "" } }] }))
      }
    } else if (payload.type === "message_delta") {
      if (payload.delta?.stop_reason) {
        finishReason =
          payload.delta.stop_reason === "tool_use"
            ? "tool_calls"
            : payload.delta.stop_reason === "max_tokens"
              ? "length"
              : "stop"
      }
      if (payload.usage?.output_tokens != null && usage) usage.completion_tokens = payload.usage.output_tokens
    } else if (payload.type === "message_stop") {
      if (usage) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
      for (const f of frames) yield f
      yield makeChunk({}, finishReason)
      yield frame("[DONE]")
      return
    } else if (payload.type === "error") {
      yield frame(JSON.stringify({ error: payload.error }))
      yield frame("[DONE]")
      return
    }

    for (const f of frames) yield f
  }

  if (usage) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens
  yield makeChunk({}, finishReason)
  yield frame("[DONE]")
}

function configPaths(): string[] {
  const paths: string[] = []
  if (process.env.OPENCODE_GO_GATEWAY_CONFIG) paths.push(process.env.OPENCODE_GO_GATEWAY_CONFIG)
  paths.push(join(process.cwd(), "gateway.config.json"))
  try {
    paths.push(join(import.meta.dirname, "..", "gateway.config.json"))
  } catch {
    void 0
  }
  return paths
}

export function loadFileConfig(): any {
  for (const path of configPaths()) {
    try {
      if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"))
    } catch {
      continue
    }
  }
  return undefined
}

function readAuthKey(): string | undefined {
  const env =
    process.env.OPENCODE_GO_API_KEY || process.env.OPENCODE_API_KEY || process.env.OPENCODE_ZEN_API_KEY
  if (env) return env.trim()

  const fileConfig = loadFileConfig()
  if (fileConfig) {
    const fromFile = fileConfig.apiKey ?? fileConfig.key ?? fileConfig["opencode-go"]?.key
    if (fromFile) return String(fromFile).trim()
    const nested = fileConfig.models?.["opencode-go"]?.apiKey
    if (nested) return String(nested).trim()
  }

  const candidates: string[] = []
  if (process.env.OPENCODE_AUTH_FILE) candidates.push(process.env.OPENCODE_AUTH_FILE)
  if (process.env.XDG_DATA_HOME) candidates.push(join(process.env.XDG_DATA_HOME, "opencode", "auth.json"))
  candidates.push(join(homedir(), ".local", "share", "opencode", "auth.json"))
  if (process.platform === "win32" && process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, "opencode", "auth.json"))
  }
  if (process.platform === "darwin") {
    candidates.push(join(homedir(), "Library", "Application Support", "opencode", "auth.json"))
  }
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue
      const data = JSON.parse(readFileSync(path, "utf8"))
      const entry = data["opencode-go"] ?? data["opencode"]
      if (entry?.key) return String(entry.key).trim()
    } catch {
      continue
    }
  }
  return undefined
}

function sessionIdFor(request: Request, body: any) {
  const header =
    request.headers.get("x-opencode-session") ||
    request.headers.get("x-session-id") ||
    body?.metadata?.session_id
  if (header) return String(header)
  const firstUser = (body?.messages ?? []).find((m: any) => m.role === "user")
  const seed = `${body?.model ?? "unknown"}:${textOfContent(firstUser?.content)}`
  return createHash("sha1").update(seed).digest("hex").slice(0, 32)
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...CORS } })
}

function errorResponse(message: string, status = 400, type = "invalid_request_error") {
  return jsonResponse({ error: { message, type, code: null, param: null } }, status)
}

export type Protocol = "openai" | "anthropic" | "responses"

export type UpstreamConfig = {
  id?: string
  name?: string
  type?: Protocol | "opencode-go"
  prefix?: string
  baseURL?: string
  apiKey?: string
  enabled?: boolean
  protocol?: Protocol
  protocols?: Record<string, Protocol>
  responsesModels?: string[]
  anthropicModels?: string[]
  responsesPrefixes?: string[]
  anthropicPrefixes?: string[]
  models?: string[] | Record<string, unknown>
  sessionHeader?: boolean
  headers?: Record<string, string>
  authHeader?: "bearer" | "x-api-key" | "both" | "none"
  stripParams?: string[]
  modelParams?: Record<string, Record<string, unknown>>
  reasoningEffortMap?: Record<string, string>
  paramFallback?: boolean
  usageBase?: string
  usage?: boolean
}

type Upstream = {
  id: string
  name: string
  prefix: string
  baseURL: string
  apiKey?: string
  enabled: boolean
  protocol: Protocol
  protocols: Map<string, Protocol>
  responsesPrefixes: string[]
  anthropicPrefixes: string[]
  models?: string[]
  sessionHeader: boolean
  headers: Record<string, string>
  authHeader?: "bearer" | "x-api-key" | "both" | "none"
  stripParams: string[]
  modelParams: Record<string, Record<string, unknown>>
  reasoningEffortMap: Record<string, string>
  paramFallback: boolean
  usageBase?: string
  presetOpenCodeGo: boolean
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "")
}

export function buildUpstreams(config: any = {}): Upstream[] {
  const rawList: UpstreamConfig[] =
    Array.isArray(config.upstreams) && config.upstreams.length
      ? config.upstreams
      : [
          {
            id: "opencode",
            name: "OpenCode Go",
            type: "opencode-go",
            prefix: "opencode",
            apiKey: config.apiKey,
            enabled: true,
          },
        ]

  return rawList.map((raw, index) => {
    const type = raw.type ?? "openai"
    const preset = type === "opencode-go"
    const id = raw.id ?? (preset ? "opencode" : `upstream${index + 1}`)
    const prefix = trimSlash(raw.prefix ?? id)
    const baseURL = trimSlash(raw.baseURL ?? (preset ? GO_BASE : ""))

    const protocols = new Map<string, Protocol>()
    if (raw.protocols) {
      for (const [key, value] of Object.entries(raw.protocols)) protocols.set(key, value as Protocol)
    }
    if (raw.responsesModels) for (const model of raw.responsesModels) protocols.set(model, "responses")
    if (raw.anthropicModels) for (const model of raw.anthropicModels) protocols.set(model, "anthropic")
    if (preset) for (const model of RESPONSES_MODELS) if (!protocols.has(model)) protocols.set(model, "responses")

    let models: string[] | undefined
    if (Array.isArray(raw.models)) models = raw.models
    else if (raw.models && typeof raw.models === "object") models = Object.keys(raw.models)

    const protocol: Protocol = raw.protocol ?? (type === "opencode-go" || type === "openai" ? "openai" : type)

    return {
      id,
      name: raw.name ?? (preset ? "OpenCode Go" : id),
      prefix,
      baseURL,
      apiKey: raw.apiKey,
      enabled: raw.enabled !== false,
      protocol,
      protocols,
      responsesPrefixes: raw.responsesPrefixes ?? [],
      anthropicPrefixes: raw.anthropicPrefixes ?? [],
      models,
      sessionHeader: raw.sessionHeader ?? preset,
      headers: raw.headers ?? {},
      authHeader: raw.authHeader,
      stripParams: raw.stripParams ?? [],
      modelParams: raw.modelParams ?? {},
      reasoningEffortMap: raw.reasoningEffortMap ?? {},
      paramFallback: raw.paramFallback !== false,
      usageBase:
        raw.usage === false
          ? undefined
          : raw.usageBase
            ? trimSlash(raw.usageBase)
            : preset
              ? baseURL
              : undefined,
      presetOpenCodeGo: preset,
    }
  })
}

function upstreamHeaders(upstream: Upstream, session: string, protocol?: Protocol) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    ...upstream.headers,
  }
  const apiKey = upstream.apiKey ?? (upstream.presetOpenCodeGo ? readAuthKey() : undefined)
  const mode = upstream.authHeader ?? (protocol === "anthropic" ? "both" : "bearer")
  if (apiKey && (mode === "bearer" || mode === "both")) headers.authorization = `Bearer ${apiKey}`
  if (apiKey && (mode === "x-api-key" || mode === "both")) headers["x-api-key"] = apiKey
  if (protocol === "anthropic" && !headers["anthropic-version"]) headers["anthropic-version"] = "2023-06-01"
  if (upstream.sessionHeader) headers["x-opencode-session"] = session
  return headers
}

function protocolFor(upstream: Upstream, model: string): Protocol {
  const explicit = upstream.protocols.get(model)
  if (explicit) return explicit
  for (const prefix of upstream.responsesPrefixes) if (model.startsWith(prefix)) return "responses"
  for (const prefix of upstream.anthropicPrefixes) if (model.startsWith(prefix)) return "anthropic"
  return upstream.protocol
}

async function fetchUpstreamModels(upstream: Upstream) {
  if (upstream.models) return upstream.models
  try {
    const response = await fetch(`${upstream.baseURL}/models`, {
      headers: upstreamHeaders(upstream, "models"),
    })
    if (response.ok) {
      const json = await response.json()
      const data = Array.isArray(json) ? json : json?.data
      if (Array.isArray(data)) {
        return data.map((item: any) => (typeof item === "string" ? item : item?.id)).filter(Boolean)
      }
    }
  } catch {
    void 0
  }
  return upstream.presetOpenCodeGo ? FALLBACK_MODELS : []
}

function resolveModel(model: string, upstreams: Upstream[]) {
  const active = upstreams
    .filter((upstream) => upstream.enabled && upstream.baseURL)
    .sort((a, b) => b.prefix.length - a.prefix.length)
  for (const upstream of active) {
    if (upstream.prefix && model.startsWith(`${upstream.prefix}/`)) {
      return { upstream, model: model.slice(upstream.prefix.length + 1) }
    }
  }
  const stripped = model.replace(/^opencode-go\//, "").replace(/^opencode\//, "")
  return active[0] ? { upstream: active[0], model: stripped } : undefined
}

const REASONING_KEYS = [
  "reasoning_effort",
  "reasoningEffort",
  "reasoning",
  "thinking",
  "enable_thinking",
  "thinking_budget",
  "include_reasoning",
  "effort",
  "verbosity",
]

export function applyParamRules(body: any, upstream: Upstream, model: string) {
  const out: any = { ...body }
  const perModel = upstream.modelParams[model]
  if (perModel) Object.assign(out, perModel)
  if (out.reasoning_effort != null) {
    const mapped = upstream.reasoningEffortMap[String(out.reasoning_effort)]
    if (mapped != null) out.reasoning_effort = mapped
  }
  for (const key of upstream.stripParams) delete out[key]
  return out
}

export function stripReasoningParams(body: any) {
  const out: any = { ...body }
  let changed = false
  for (const key of REASONING_KEYS) {
    if (key in out) {
      delete out[key]
      changed = true
    }
  }
  return { body: out, changed }
}

export function isParamError(status: number, text: string) {
  if (status !== 400 && status !== 422) return false
  return /reasoning|thinking|effort|unknown (field|parameter)|unexpected|unsupported|invalid[ _-]?(request|param)|parameter|不支持|参数/i.test(text)
}

const DEEPSEEK_REASONING = new Map<string, Map<string, string>>()
const MAX_REASONING_SESSIONS = 200

function isDeepSeekModel(model: string) {
  return /deepseek/i.test(model)
}

function reasoningCache(session: string) {
  let cache = DEEPSEEK_REASONING.get(session)
  if (!cache) {
    if (DEEPSEEK_REASONING.size >= MAX_REASONING_SESSIONS) {
      const oldest = DEEPSEEK_REASONING.keys().next().value
      if (oldest !== undefined) DEEPSEEK_REASONING.delete(oldest)
    }
    cache = new Map()
    DEEPSEEK_REASONING.set(session, cache)
  }
  return cache
}

export function injectReasoningContent(messages: any, session: string) {
  if (!Array.isArray(messages)) return messages
  const cache = DEEPSEEK_REASONING.get(session)
  for (const message of messages) {
    if (message?.role !== "assistant") continue
    if (typeof message.reasoning_content === "string") continue
    let text = ""
    if (cache && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const hit = call?.id ? cache.get(call.id) : undefined
        if (hit) {
          text = hit
          break
        }
      }
    }
    message.reasoning_content = text
  }
  return messages
}

export function captureReasoningContent(session: string, message: any) {
  if (!message) return
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  if (!calls.length) return
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : ""
  const cache = reasoningCache(session)
  for (const call of calls) if (call?.id) cache.set(call.id, reasoning)
}

function reasoningCaptureStream(session: string) {
  const decoder = new TextDecoder()
  let buffer = ""
  let reasoning = ""
  const ids: string[] = []
  const flush = () => {
    if (ids.length) {
      const cache = reasoningCache(session)
      for (const id of ids) cache.set(id, reasoning)
    }
    ids.length = 0
    reasoning = ""
  }
  const inspect = (block: string) => {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (data === "[DONE]") {
        flush()
        continue
      }
      let payload: any
      try {
        payload = JSON.parse(data)
      } catch {
        continue
      }
      const choice = payload?.choices?.[0]
      const delta = choice?.delta
      if (delta) {
        if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) if (call?.id) ids.push(call.id)
        }
      }
      if (choice?.finish_reason) flush()
    }
  }
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      buffer += decoder.decode(chunk, { stream: true })
      let index = buffer.indexOf("\n\n")
      while (index !== -1) {
        inspect(buffer.slice(0, index))
        buffer = buffer.slice(index + 2)
        index = buffer.indexOf("\n\n")
      }
    },
    flush() {
      if (buffer.trim()) inspect(buffer)
      flush()
    },
  })
}

async function sendOnce(
  upstream: Upstream,
  protocol: Protocol,
  body: any,
  stream: boolean,
  model: string,
  headers: Record<string, string>,
  session: string,
) {
  if (protocol === "openai") {
    const response = await fetch(`${upstream.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
    if (!response.ok) return response
    if (stream && response.body) {
      const out = isDeepSeekModel(model) ? response.body.pipeThrough(reasoningCaptureStream(session)) : response.body
      return new Response(out, { status: 200, headers: { ...SSE_HEADERS, ...CORS } })
    }
    if (isDeepSeekModel(model)) {
      response
        .clone()
        .json()
        .then((json) => captureReasoningContent(session, json?.choices?.[0]?.message))
        .catch(() => {})
    }
    return response
  }

  if (protocol === "responses") {
    const response = await fetch(`${upstream.baseURL}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(chatToResponses(body)),
    })
    if (!response.ok) return response
    if (stream) {
      if (!response.body) return errorResponse("Upstream returned no body", 502)
      return new Response(streamFromAsync(responsesStreamToChat(response.body, model)), {
        status: 200,
        headers: { ...SSE_HEADERS, ...CORS },
      })
    }
    return jsonResponse(responsesToChat(await response.json(), model))
  }

  const response = await fetch(`${upstream.baseURL}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(chatToAnthropicRequest(body)),
  })
  if (!response.ok) return response
  if (stream) {
    if (!response.body) return errorResponse("Upstream returned no body", 502)
    return new Response(streamFromAsync(anthropicStreamToChat(response.body, model)), {
      status: 200,
      headers: { ...SSE_HEADERS, ...CORS },
    })
  }
  return jsonResponse(anthropicToChatResponse(await response.json(), model))
}

function debugLog(message: string) {
  const file = process.env.OPENCODE_GO_DEBUG_LOG
  if (!file) return
  try {
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
  } catch {
    void 0
  }
}

function summarizeBody(body: any) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  let images = 0
  for (const message of messages) {
    const content = message?.content
    if (Array.isArray(content)) for (const part of content) if (part?.type === "image_url" || part?.type === "image") images += 1
  }
  const tools = Array.isArray(body?.tools) ? body.tools.length : 0
  return `model=${body?.model} stream=${Boolean(body?.stream)} messages=${messages.length} images=${images} tools=${tools} bytes=${JSON.stringify(body ?? {}).length}`
}

async function runUpstream(upstream: Upstream, model: string, chatBody: any, stream: boolean, session: string) {
  const protocol = protocolFor(upstream, model)
  const headers = upstreamHeaders(upstream, session, protocol)
  const prepared = applyParamRules({ ...chatBody, model }, upstream, model)
  if (protocol === "openai" && isDeepSeekModel(model)) injectReasoningContent(prepared.messages, session)

  debugLog(`--> ${upstream.id} ${protocol} ${summarizeBody(prepared)}`)
  const response = await sendOnce(upstream, protocol, prepared, stream, model, headers, session)
  if (response.ok) {
    debugLog(`<-- ${response.status} ok`)
    return response
  }

  let failed = response
  let text = await response.text()

  if (protocol === "openai" && /not supported for format oa-compat|Endpoint is unavailable/i.test(text)) {
    const alt = await sendOnce(upstream, "responses", prepared, stream, model, headers, session)
    if (alt.ok) {
      debugLog(`<-- ${alt.status} ok (responses fallback)`)
      return alt
    }
    failed = alt
    text = await alt.text()
  }
  debugLog(`<-- ${failed.status} ${text.slice(0, 4000)}`)
  if (upstream.paramFallback) {
    const { body: retryBody, changed } = stripReasoningParams(prepared)
    if (changed && isParamError(failed.status, text)) {
      const retry = await sendOnce(upstream, protocol, retryBody, stream, model, headers, session)
      if (retry.ok) return retry
      return relayError(retry)
    }
  }
  return new Response(text, {
    status: failed.status,
    headers: { "content-type": failed.headers.get("content-type") ?? "application/json", ...CORS },
  })
}

async function relayError(response: Response) {
  const text = await response.text()
  return new Response(text, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json", ...CORS },
  })
}

async function readJson(request: Request) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

export type UsageErrorCode = "CREDENTIAL_NOT_RESOLVED" | "VENDOR_API_UNREACHABLE" | "INVALID_RESPONSE"

export class UsageError extends Error {
  readonly code: UsageErrorCode
  readonly status?: number

  constructor(message: string, code: UsageErrorCode, status?: number) {
    super(message)
    this.name = "UsageError"
    this.code = code
    this.status = status
  }
}

const USAGE_WINDOWS = ["rolling", "weekly", "monthly"] as const
export type UsagePeriod = (typeof USAGE_WINDOWS)[number]

export type UsageRow = {
  id: string
  name: string
  vendor: "opencode"
  kind: "usage"
  percent: number
  remaining: number
  resetAt: string
  period: UsagePeriod
  provenance: "vendor-api"
}

export function parseUsagePayload(raw: unknown): Array<{ period: UsagePeriod; percent: number; resetsAt: string }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new UsageError("OpenCode response is not an object", "INVALID_RESPONSE")
  }
  const usage = (raw as Record<string, unknown>)["usage"]
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    throw new UsageError("OpenCode response missing usage envelope", "INVALID_RESPONSE")
  }
  const record = usage as Record<string, unknown>
  const out: Array<{ period: UsagePeriod; percent: number; resetsAt: string }> = []
  for (const period of USAGE_WINDOWS) {
    const window = record[period]
    if (typeof window !== "object" || window === null || Array.isArray(window)) continue
    const percent = (window as Record<string, unknown>)["percent"]
    const resetsAt = (window as Record<string, unknown>)["resetsAt"]
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue
    if (typeof resetsAt !== "string" || resetsAt.length === 0) continue
    out.push({ period, percent, resetsAt })
  }
  return out
}

export async function readOpenCodeUsage(options: {
  id: string
  name?: string
  baseURL: string
  apiKey?: string
  fetchFn?: typeof fetch
  timeoutMs?: number
}): Promise<UsageRow[]> {
  if (!options.apiKey) throw new UsageError("OpenCode access token not resolved", "CREDENTIAL_NOT_RESOLVED")
  const fetchFn = options.fetchFn ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  let response: Response
  try {
    response = await fetchFn(`${trimSlash(options.baseURL)}/usage`, {
      headers: { authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error: any) {
    throw new UsageError(`OpenCode API unreachable: ${error?.message ?? error}`, "VENDOR_API_UNREACHABLE")
  }
  if (!response.ok) {
    throw new UsageError(`OpenCode API returned ${response.status}`, "VENDOR_API_UNREACHABLE", response.status)
  }
  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    throw new UsageError("OpenCode response is not valid JSON", "INVALID_RESPONSE")
  }
  return parseUsagePayload(raw).map((window) => ({
    id: `${options.id}:${window.period}`,
    name: options.name ?? "OpenCode",
    vendor: "opencode" as const,
    kind: "usage" as const,
    percent: window.percent,
    remaining: Math.max(0, 100 - window.percent),
    resetAt: window.resetsAt,
    period: window.period,
    provenance: "vendor-api" as const,
  }))
}

function landingPage(origin: string) {
  return `LLM Gateway (no web UI)

OpenAI (compatible)   ${origin}/v1
Anthropic (compatible) ${origin}
Health                 ${origin}/health
Usage                  ${origin}/api/usage
`
}

export type GatewayOptions = {
  port?: number
  hostname?: string
  token?: string
  apiKey?: string
  upstreams?: UpstreamConfig[]
}

export function createHandler(options: GatewayOptions = {}) {
  const config = loadFileConfig() ?? {}
  const merged = { ...config, ...options, upstreams: options.upstreams ?? config.upstreams }
  const upstreams = buildUpstreams(merged)
  const token = options.token ?? config.token ?? process.env.OPENCODE_GO_GATEWAY_TOKEN
  const catalogCache = new Map<string, { at: number; models: string[] }>()

  async function catalog(force = false) {
    const groups: { name: string; prefix: string; models: string[] }[] = []
    for (const upstream of upstreams.filter((item) => item.enabled && item.baseURL)) {
      const cached = catalogCache.get(upstream.id)
      let models: string[]
      if (!force && cached && Date.now() - cached.at < MODELS_TTL_MS) {
        models = cached.models
      } else {
        models = await fetchUpstreamModels(upstream)
        catalogCache.set(upstream.id, { at: Date.now(), models })
      }
      groups.push({ name: upstream.name, prefix: upstream.prefix, models })
    }
    return groups
  }

  const usageTargets = upstreams.filter((item) => item.enabled && item.usageBase)

  async function readAllUsage() {
    const entries: UsageRow[] = []
    const errors: Array<{ id: string; code: string; message: string; status?: number }> = []
    for (const upstream of usageTargets) {
      try {
        const rows = await readOpenCodeUsage({
          id: upstream.id,
          name: upstream.name,
          baseURL: upstream.usageBase as string,
          apiKey: upstream.apiKey ?? (upstream.presetOpenCodeGo ? readAuthKey() : undefined),
        })
        entries.push(...rows)
      } catch (error: any) {
        errors.push({
          id: upstream.id,
          code: error?.code ?? "UNKNOWN",
          message: error?.message ?? String(error),
          ...(error?.status !== undefined ? { status: error.status } : {}),
        })
      }
    }
    return { generatedAt: Date.now(), entries, errors }
  }

  async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method.toUpperCase()

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })

    if (token && path.startsWith("/v1")) {
      const auth = request.headers.get("authorization") ?? ""
      const provided = auth.startsWith("Bearer ") ? auth.slice(7) : (request.headers.get("x-api-key") ?? "")
      if (provided !== token) return errorResponse("Invalid gateway token", 401, "authentication_error")
    }

    try {
      if (method === "GET" && (path === "/" || path === "/health")) {
        if (path === "/health") {
          return jsonResponse({
            status: "ok",
            version: VERSION,
            upstreams: upstreams.filter((item) => item.enabled).map((item) => item.id),
          })
        }
        return new Response(landingPage(url.origin), {
          headers: { "content-type": "text/plain; charset=utf-8", ...CORS },
        })
      }

      if (method === "GET" && (path === "/api/usage" || path === "/usage")) {
        return jsonResponse(await readAllUsage())
      }

      if (method === "GET" && (path === "/v1/models" || path === "/models")) {
        const groups = await catalog()
        const data: any[] = []
        for (const group of groups) {
          for (const id of group.models) {
            data.push({
              id: `${group.prefix}/${id}`,
              object: "model",
              created: Math.floor(Date.now() / 1000),
              owned_by: group.prefix,
              name: `${group.prefix}/${id}`,
            })
          }
        }
        return jsonResponse({ object: "list", data })
      }

      if (method === "GET" && path.startsWith("/v1/models/")) {
        const id = decodeURIComponent(path.slice("/v1/models/".length))
        return jsonResponse({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: id.split("/")[0] ?? "unknown",
          name: id,
        })
      }

      if (method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
        const body = await readJson(request)
        if (!body?.model) return errorResponse("Missing required field: model")
        const resolved = resolveModel(body.model, upstreams)
        if (!resolved) return errorResponse(`No enabled upstream for model ${body.model}`, 404, "model_not_found")
        const session = sessionIdFor(request, body)
        return await runUpstream(resolved.upstream, resolved.model, body, Boolean(body.stream), session)
      }

      if (method === "POST" && (path === "/v1/messages" || path === "/messages")) {
        const body = await readJson(request)
        if (!body?.model) return errorResponse("Missing required field: model")
        const resolved = resolveModel(body.model, upstreams)
        if (!resolved) return errorResponse(`No enabled upstream for model ${body.model}`, 404, "model_not_found")
        const session = sessionIdFor(request, body)
        const pivot = anthropicToChat({ ...body, model: resolved.model })
        const response = await runUpstream(resolved.upstream, resolved.model, pivot, Boolean(body.stream), session)
        if (!response.ok) return response
        if (body.stream) {
          if (!response.body) return errorResponse("Upstream returned no body", 502)
          return new Response(streamFromAsync(chatStreamToAnthropic(response.body, resolved.model)), {
            status: 200,
            headers: { ...SSE_HEADERS, ...CORS },
          })
        }
        return jsonResponse(chatToAnthropic(await response.json(), resolved.model))
      }

      if (method === "POST" && (path === "/v1/responses" || path === "/responses")) {
        const body = await readJson(request)
        if (!body?.model) return errorResponse("Missing required field: model")
        const resolved = resolveModel(body.model, upstreams)
        if (!resolved) return errorResponse(`No enabled upstream for model ${body.model}`, 404, "model_not_found")
        if (protocolFor(resolved.upstream, resolved.model) !== "responses") {
          return errorResponse(
            `Upstream ${resolved.upstream.id} does not speak the Responses API for ${resolved.model}; use /v1/chat/completions`,
            501,
            "not_implemented",
          )
        }
        const session = sessionIdFor(request, body)
        const response = await fetch(`${resolved.upstream.baseURL}/responses`, {
          method: "POST",
          headers: upstreamHeaders(resolved.upstream, session),
          body: JSON.stringify({ ...body, model: resolved.model }),
        })
        if (!response.ok) return relayError(response)
        if (body.stream && response.body) {
          return new Response(response.body, { status: 200, headers: { ...SSE_HEADERS, ...CORS } })
        }
        return new Response(await response.text(), {
          status: response.status,
          headers: { "content-type": response.headers.get("content-type") ?? "application/json", ...CORS },
        })
      }

      return errorResponse("Not found", 404, "not_found_error")
    } catch (error: any) {
      debugLog(`!! handler error: ${error?.stack ?? error?.message ?? error}`)
      return errorResponse(error?.message ?? "Internal gateway error", 500, "api_error")
    }
  }

  return { handler, catalog, upstreams, token }
}

export function createGateway(options: GatewayOptions = {}) {
  const hostname = options.hostname ?? process.env.OPENCODE_GO_GATEWAY_HOST ?? "127.0.0.1"
  const parsedPort = options.port ?? Number(process.env.OPENCODE_GO_GATEWAY_PORT ?? DEFAULT_PORT)
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT
  const { handler } = createHandler(options)

  try {
    const server = Bun.serve({ hostname, port, fetch: handler })
    return { server, port, hostname, handler, started: true, error: undefined }
  } catch (error: any) {
    return { server: undefined, port, hostname, handler, started: false, error }
  }
}

declare const Bun: any

async function safeLog(client: any, level: string, message: string) {
  try {
    await client?.app?.log?.({ body: { service: "opencode-go-gateway", level, message } })
  } catch {
    return
  }
}

export type GatewayPlugin = (input: any, options?: any) => Promise<Record<string, unknown>>

export const OpenCodeGoGateway: GatewayPlugin = async ({ client }, options) => {
  const opts = (options ?? {}) as GatewayOptions
  const globalKey = Symbol.for("opencode-go-gateway.server")
  const store = globalThis as any

  if (!store[globalKey]) {
    const gateway = createGateway(opts)
    store[globalKey] = gateway
    if (gateway.started) {
      await safeLog(client, "info", `OpenCode Go gateway listening on http://${gateway.hostname}:${gateway.port}/v1`)
    } else {
      const message = String(gateway.error?.message ?? gateway.error ?? "")
      const inUse = gateway.error?.code === "EADDRINUSE" || /EADDRINUSE|in use/i.test(message)
      await safeLog(
        client,
        inUse ? "info" : "warn",
        inUse
          ? `OpenCode Go gateway already running on port ${gateway.port}`
          : `OpenCode Go gateway did not start on port ${gateway.port}: ${message}`,
      )
    }
  }

  return {
    dispose: async () => {
      const gateway = store[globalKey]
      if (gateway?.started) {
        try {
          gateway.server?.stop?.(true)
        } catch {
          void 0
        }
      }
      delete store[globalKey]
    },
  }
}

export default OpenCodeGoGateway
