import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createLocalClient, type LocalClient } from "./backend-client.ts"
import { ensureBackend, killBackendFor, sleep, type EnsureBackendConfig } from "./backend.ts"
import { createToolCallFilter, createExternalToolCallStreamParser, stripFunctionCallMarkup, parseExternalToolCallsFromText } from "./parser.ts"
import {
  buildExternalToolRegistry,
  buildToolExposure,
  evaluateToolPolicy,
  findExternalToolByName,
  validateToolCalls,
  EXTERNAL_TOOL_PREFIX,
  type ExternalTool,
} from "./tools.ts"

/**
 * Embedded OpenCode-to-OpenAI proxy (ported from TiaraBasori/opencode2api v2, MIT).
 *
 * Exposes OpenAI Chat Completions + Responses semantics over a managed local
 * `opencode serve` backend, as an in-process gateway upstream — no HTTP hop,
 * no separate process, no external dependencies.
 */

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" }

const DEFAULT_REQUEST_TIMEOUT_MS = 300000
const DEFAULT_POLL_INTERVAL_MS = 500
const RETRY_BACKOFF_BASE_MS = 800
const RETRY_MAX_ATTEMPTS = 3
const DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS = Number(process.env.OPENCODE2API_EVENT_FIRST_DELTA_TIMEOUT_MS) || 30000
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = Number(process.env.OPENCODE2API_EVENT_IDLE_TIMEOUT_MS) || 8000

export type LocalProxyConfig = {
  id: string
  serverUrl: string
  serverPassword?: string
  opencodePath: string
  manageBackend: boolean
  useIsolatedHome: boolean
  requestTimeoutMs: number
  disableTools: boolean
  internalWebFetchEnabled: boolean
  internalAllowedTools: string[]
  promptMode: string
  omitSystemPrompt: boolean
  zenApiKey?: string
  autoCleanupConversations: boolean
  cleanupIntervalMs: number
  cleanupMaxAgeMs: number
  eventIdleTimeoutMs?: number
  eventFirstDeltaTimeoutMs?: number
  debug: boolean
  toolLockPluginPath: string
}

export function normalizeLocalProxyConfig(raw: any): LocalProxyConfig {
  const normalizeBool = (value: any, fallback: boolean | undefined = undefined) => {
    if (typeof value === "boolean") return value
    if (typeof value === "number") return value === 1
    if (typeof value === "string") {
      const v = value.trim().toLowerCase()
      if (["1", "true", "yes", "y", "on"].includes(v)) return true
      if (["0", "false", "no", "n", "off"].includes(v)) return false
    }
    return fallback
  }
  const promptMode = raw.promptMode ?? raw.PROMPT_MODE ?? process.env.OPENCODE_PROXY_PROMPT_MODE ?? "standard"
  return {
    id: raw.id ?? "local",
    serverUrl: (raw.baseURL ?? raw.serverUrl ?? "http://127.0.0.1:10001").replace(/\/+$/, ""),
    serverPassword: raw.serverPassword ?? process.env.OPENCODE_SERVER_PASSWORD ?? "",
    opencodePath: raw.opencodePath ?? "opencode",
    manageBackend: normalizeBool(raw.manageBackend, true)!,
    useIsolatedHome:
      normalizeBool(raw.useIsolatedHome) ??
      normalizeBool(process.env.OPENCODE_USE_ISOLATED_HOME) ??
      false,
    requestTimeoutMs: Number(raw.requestTimeoutMs ?? process.env.OPENCODE_PROXY_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS,
    disableTools: normalizeBool(raw.disableTools, true)!,
    internalWebFetchEnabled: normalizeBool(raw.internalWebFetchEnabled, false)!,
    internalAllowedTools: Array.isArray(raw.internalAllowedTools)
      ? raw.internalAllowedTools.map((entry: any) => String(entry).trim()).filter(Boolean)
      : typeof raw.internalAllowedTools === "string"
        ? raw.internalAllowedTools.split(",").map((entry: string) => entry.trim()).filter(Boolean)
        : [],
    promptMode,
    omitSystemPrompt: normalizeBool(raw.omitSystemPrompt) ?? normalizeBool(process.env.OPENCODE_PROXY_OMIT_SYSTEM_PROMPT) ?? promptMode === "plugin-inject",
    zenApiKey: raw.zenApiKey ?? process.env.OPENCODE_ZEN_API_KEY ?? "",
    autoCleanupConversations: normalizeBool(raw.autoCleanupConversations, false)!,
    cleanupIntervalMs: Number(raw.cleanupIntervalMs ?? process.env.OPENCODE_PROXY_CLEANUP_INTERVAL_MS) || 12 * 60 * 60 * 1000,
    cleanupMaxAgeMs: Number(raw.cleanupMaxAgeMs ?? process.env.OPENCODE_PROXY_CLEANUP_MAX_AGE_MS) || 24 * 60 * 60 * 1000,
    eventIdleTimeoutMs: Number(raw.eventIdleTimeoutMs) || undefined,
    eventFirstDeltaTimeoutMs: Number(raw.eventFirstDeltaTimeoutMs) || undefined,
    debug:
      String(raw.debug ?? "").toLowerCase() === "true" ||
      raw.debug === "1" ||
      String(process.env.OPENCODE_PROXY_DEBUG || "").toLowerCase() === "true" ||
      process.env.OPENCODE_PROXY_DEBUG === "1",
    toolLockPluginPath: raw.toolLockPluginPath ?? "",
  }
}

// --- transient error detection & transforms ---------------------------------

function isTransientUpstreamError(error: any) {
  if (!error) return false
  const message = [error.message, error.data?.message].filter((part) => typeof part === "string").join(" ")
  if (!message) return false

  const transientSignatures = [
    /insufficient balance/i,
    /credits?error/i,
    /rate.?limit/i,
    /too many requests/i,
    /worker request limit/i,
    /overloaded/i,
    /temporarily unavailable/i,
    /internal server error/i,
    /bad gateway/i,
    /service unavailable/i,
    /stream error/i,
  ]
  if (transientSignatures.some((re) => re.test(message))) return true

  const statusMatch = message.match(/\b(\d{3}):/)
  const status = statusMatch ? Number(statusMatch[1]) : error.statusCode || error.data?.status || null
  if (typeof status === "number") {
    if (status === 401 || status === 402 || status === 429) return true
    if (status >= 500) return true
  }
  return false
}

function transformUpstreamError(error: any) {
  let statusCode = 500
  let message = error.message || "Internal server error"
  let type = "internal_error"
  let code = error.code || error.constructor?.name

  if (error.message && error.message.includes("Request timeout")) {
    statusCode = 504
    type = "timeout"
    code = "timeout"
    message = "Request timeout"
  } else if (error.message && error.message.includes("ENOENT")) {
    statusCode = 500
    type = "internal_error"
    code = "file_access_error"
    message = "OpenCode backend file access error. This may be a Windows compatibility issue. Please try restarting the service."
  } else if (error.statusCode) {
    statusCode = error.statusCode
    const upstreamType = error.code || error.type || ""
    const upstreamMessage = error.message || ""

    if (
      upstreamType === "CreditsError" ||
      upstreamType === "InsufficientBalanceError" ||
      upstreamMessage.toLowerCase().includes("insufficient balance") ||
      upstreamMessage.toLowerCase().includes("insufficient credits") ||
      upstreamMessage.toLowerCase().includes("billing") ||
      upstreamMessage.toLowerCase().includes("quota exceeded") ||
      upstreamMessage.toLowerCase().includes("credit limit")
    ) {
      statusCode = 402
      type = "insufficient_quota"
      code = "insufficient_quota"
      message = upstreamMessage || "Insufficient balance or quota exceeded"
    } else if (
      upstreamType === "RateLimitError" ||
      upstreamType === "TooManyRequestsError" ||
      statusCode === 429 ||
      upstreamMessage.toLowerCase().includes("rate limit") ||
      upstreamMessage.toLowerCase().includes("too many requests")
    ) {
      statusCode = 429
      type = "rate_limit_exceeded"
      code = "rate_limit_exceeded"
      message = upstreamMessage || "Rate limit exceeded"
    } else if (
      upstreamType === "AuthenticationError" ||
      upstreamType === "InvalidAPIKeyError" ||
      statusCode === 401 ||
      upstreamMessage.toLowerCase().includes("invalid api key") ||
      upstreamMessage.toLowerCase().includes("unauthorized") ||
      upstreamMessage.toLowerCase().includes("authentication")
    ) {
      statusCode = 401
      type = "invalid_api_key"
      code = "invalid_api_key"
      message = upstreamMessage || "Invalid API key"
    } else if (
      upstreamType === "PermissionError" ||
      statusCode === 403 ||
      upstreamMessage.toLowerCase().includes("permission denied") ||
      upstreamMessage.toLowerCase().includes("access denied")
    ) {
      statusCode = 403
      type = "permission_denied"
      code = "permission_denied"
      message = upstreamMessage || "Permission denied"
    } else if (
      upstreamType === "NotFoundError" ||
      statusCode === 404 ||
      upstreamMessage.toLowerCase().includes("model not found") ||
      upstreamMessage.toLowerCase().includes("does not exist")
    ) {
      statusCode = 404
      type = "model_not_found"
      code = "model_not_found"
      message = upstreamMessage || "Model not found"
    } else if (statusCode === 400 || upstreamType === "BadRequestError") {
      statusCode = 400
      type = "invalid_request_error"
      code = "invalid_request_error"
      message = upstreamMessage || "Invalid request"
    } else if (statusCode >= 500) {
      statusCode = 502
      type = "server_error"
      code = "server_error"
      message = upstreamMessage || "Upstream provider error"
    } else {
      type = upstreamType.toLowerCase().replace(/error$/, "_error") || "upstream_error"
      code = upstreamType
      message = upstreamMessage
    }
  }

  return {
    statusCode,
    error: {
      message,
      type,
      ...(code && { code }),
      ...(error.availableModels && { available_models: error.availableModels }),
    },
  }
}

function errorResponse(transformed: { statusCode: number; error: any }) {
  return new Response(JSON.stringify(transformed.error), {
    status: transformed.statusCode,
    headers: { ...JSON_HEADERS, ...CORS },
  })
}

// --- mutex (serialize requests through one backend) -------------------------

type QueueEntry = { task: () => Promise<any>; timeout: number; resolve: (v: any) => void; reject: (e: any) => void }

function createMutex() {
  const queue: QueueEntry[] = []
  let isProcessing = false

  function processQueue() {
    if (isProcessing || queue.length === 0) return
    isProcessing = true
    const { task, timeout, resolve, reject } = queue.shift()!
    let settled = false
    const timeoutMs = timeout || 120000
    const timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`Request timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    Promise.resolve()
      .then(task)
      .then((result) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        resolve(result)
      })
      .catch((err) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        reject(err)
      })
      .finally(() => {
        isProcessing = false
        if (queue.length > 0) queueMicrotask(processQueue)
      })
  }

  return function lock(task: () => Promise<any>, timeout = 120000) {
    return new Promise((resolve, reject) => {
      queue.push({ task, timeout, resolve, reject })
      processQueue()
    })
  }
}

async function getImageDataUri(url: string) {
  if (url.startsWith("data:")) return url
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error(`Invalid URL scheme: ${url}`)
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(`Failed to fetch image: HTTP ${response.status}`)
  const contentType = response.headers.get("content-type") || "image/jpeg"
  const buffer = Buffer.from(await response.arrayBuffer())
  return `data:${contentType};base64,${buffer.toString("base64")}`
}

export type LocalProxy = {
  id: string
  listModels(): Promise<string[]>
  handleChat(body: any, stream: boolean): Promise<Response>
  handleResponses(body: any, stream: boolean): Promise<Response>
  healthDetails(): any
  metricsText(): string
  warmup(): Promise<void>
  killBackend(): void
}

export function createLocalProxy(config: LocalProxyConfig): LocalProxy {
  const {
    serverUrl,
    serverPassword,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    debug: DEBUG,
    disableTools: DISABLE_TOOLS,
    internalWebFetchEnabled: INTERNAL_WEB_FETCH_ENABLED,
    internalAllowedTools: INTERNAL_ALLOWED_TOOLS,
    promptMode: PROMPT_MODE,
    omitSystemPrompt: OMIT_SYSTEM_PROMPT,
    autoCleanupConversations: AUTO_CLEANUP_CONVERSATIONS,
    cleanupIntervalMs: CLEANUP_INTERVAL_MS,
    cleanupMaxAgeMs: CLEANUP_MAX_AGE_MS,
    eventIdleTimeoutMs: EVENT_IDLE_TIMEOUT_MS = DEFAULT_EVENT_IDLE_TIMEOUT_MS,
    eventFirstDeltaTimeoutMs: EVENT_FIRST_DELTA_TIMEOUT_MS = DEFAULT_EVENT_FIRST_DELTA_TIMEOUT_MS,
  } = config

  const client: LocalClient = createLocalClient(serverUrl, serverPassword)
  const lock = createMutex()

  const logDebug = (...args: any[]) => {
    if (DEBUG) console.log("[Local][Debug]", ...args)
  }

  // --- models -------------------------------------------------------------

  const getProvidersList = async () => {
    const providersRes = await client.configProviders()
    const providersRaw = providersRes.data?.providers || []
    return Array.isArray(providersRaw) ? providersRaw : Object.entries(providersRaw).map(([id, info]: [string, any]) => ({ ...info, id }))
  }

  const buildModelsList = (providersList: any[]) => {
    const models: any[] = []
    providersList.forEach((p) => {
      if (p.models) {
        Object.entries(p.models).forEach(([mId, mData]: [string, any]) => {
          models.push({
            id: `${p.id}/${mId}`,
            name: typeof mData === "object" ? (mData.name || mData.label || mId) : mId,
            object: "model",
            created: mData && mData.release_date ? Math.floor(new Date(mData.release_date).getTime() / 1000) : 1704067200,
            owned_by: p.id,
          })
        })
      }
    })
    return models
  }

  const normalizeModelID = (modelID: string) =>
    modelID
      .replace(/^gpt(\d)/i, "gpt-$1")
      .replace(/^o(\d)/i, "o$1")

  const resolveRequestedModel = async (requestedModel?: string) => {
    const providersList = await getProvidersList()
    const models = buildModelsList(providersList)
    const fallbackModel = models[0]?.id || "opencode/kimi-k2.5-free"
    let [providerID, modelID] = (requestedModel || fallbackModel).split("/")
    if (!modelID) {
      modelID = providerID
      providerID = "opencode"
    }
    const originalModelID = modelID
    const normalizedModelID = normalizeModelID(modelID)
    const candidateModelIDs = [...new Set([modelID, normalizedModelID].filter(Boolean))]
    const exact = models.find((m) => candidateModelIDs.some((candidate) => m.id === `${providerID}/${candidate}`))
    if (exact) {
      const [, resolvedModelID] = exact.id.split("/")
      return {
        providerID,
        modelID: resolvedModelID,
        models,
        resolved: exact.id,
        ...(resolvedModelID !== originalModelID && { aliasFrom: `${providerID}/${originalModelID}` }),
      }
    }
    const sameProvider = models.filter((m) => m.owned_by === providerID)
    const suffixMatch = sameProvider.find((m) =>
      candidateModelIDs.some((candidate) => m.id.endsWith(`/${candidate}-free`) || m.id.endsWith(`/${candidate}`)),
    )
    if (suffixMatch) {
      const [, resolvedModelID] = suffixMatch.id.split("/")
      return { providerID, modelID: resolvedModelID, models, resolved: suffixMatch.id, aliasFrom: `${providerID}/${originalModelID}` }
    }
    const error: any = new Error(`Model not found: ${providerID}/${modelID}`)
    error.statusCode = 400
    error.code = "model_not_found"
    error.availableModels = models.map((m) => m.id)
    throw error
  }

  // --- responses API state (previous_response_id) --------------------------

  const responseState = new Map<string, { sessionId: string; model: string; expiresAt: number }>()
  const RESPONSE_STATE_TTL_MS = 30 * 60 * 1000
  const RESPONSE_STATE_SWEEP_INTERVAL_MS = 60 * 1000

  const getResponseState = (responseId: string) => {
    const state = responseState.get(responseId)
    if (!state) return null
    if (state.expiresAt <= Date.now()) {
      responseState.delete(responseId)
      return null
    }
    return state
  }

  const storeResponseState = (responseId: string, sessionId: string, model: string) => {
    if (!responseId || !sessionId) return
    responseState.set(responseId, { sessionId, model, expiresAt: Date.now() + RESPONSE_STATE_TTL_MS })
  }

  const sweepResponseState = async () => {
    const now = Date.now()
    const expired: { sessionId: string; sessionId_key?: string }[] = []
    for (const [id, state] of responseState.entries()) {
      if (state.expiresAt <= now) {
        expired.push(state)
        responseState.delete(id)
      }
    }
    if (!expired.length) return
    const liveSessionIds = new Set([...responseState.values()].map((s) => s.sessionId))
    for (const state of expired) {
      if (liveSessionIds.has(state.sessionId)) continue
      try {
        await client.sessionDelete(state.sessionId)
      } catch (e: any) {
        logDebug("Failed to delete expired response session", { sessionId: state.sessionId, error: e.message })
      }
    }
  }

  const responseStateSweepTimer = setInterval(() => {
    sweepResponseState().catch(() => {})
  }, RESPONSE_STATE_SWEEP_INTERVAL_MS)
  if (typeof responseStateSweepTimer.unref === "function") responseStateSweepTimer.unref()

  // --- tools ---------------------------------------------------------------

  const TOOL_MODE = {
    DISABLED: "disabled",
    EXTERNAL_BRIDGE: "external-bridge",
    INTERNAL_ALLOWLIST: "internal-allowlist",
  } as const
  type ToolMode = (typeof TOOL_MODE)[keyof typeof TOOL_MODE]

  const TOOL_GUARD_MESSAGE =
    "Tools are disabled. Do not call tools or function calls. Answer directly from the conversation and general knowledge. If external or real-time data is required, say so and ask the user to enable tools."
  const EXTERNAL_TOOL_GUARD_MESSAGE =
    "OpenCode internal tools remain disabled. If an external tool contract is present, use only that contract and never call or mention OpenCode internal tools."

  const normalizeConfiguredToolNames = (entries: string[] = []) =>
    [...new Set(entries.map((entry) => String(entry || "").trim()).filter(Boolean))]

  const getEffectiveInternalAllowedTools = () => {
    const configuredTools = normalizeConfiguredToolNames(INTERNAL_ALLOWED_TOOLS)
    if (configuredTools.length > 0) return configuredTools
    if (INTERNAL_WEB_FETCH_ENABLED) return ["web_fetch"]
    return []
  }

  const SERVER_INTERNAL_ALLOWED_TOOL_NAMES = getEffectiveInternalAllowedTools()

  const buildInternalAllowlistPrompt = (allowedToolNames: string[] = []) => {
    if (allowedToolNames.length > 0) {
      return `OpenCode internal tool access is limited for this turn. You may use only these built-in tools when truly required: ${allowedToolNames.join(", ")}. Do not mention or attempt any other internal tools. If the required internal tools are unavailable, answer directly and say live tool access is unavailable.`
    }
    return "OpenCode internal tools are unavailable for this turn. Answer directly without attempting tool usage."
  }

  const buildSystemPrompt = (
    systemMsg: string | undefined,
    reasoningEffort: string | null = null,
    toolMode: ToolMode = TOOL_MODE.DISABLED,
    internalAllowedTools: string[] = [],
  ) => {
    const parts: string[] = []
    if (!OMIT_SYSTEM_PROMPT && systemMsg && systemMsg.trim()) parts.push(systemMsg.trim())
    if (reasoningEffort && reasoningEffort !== "none") parts.push(`[Reasoning Effort: ${reasoningEffort}]`)
    if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
      parts.push(buildInternalAllowlistPrompt(internalAllowedTools))
    } else if (DISABLE_TOOLS && PROMPT_MODE !== "plugin-inject") {
      parts.push(toolMode === TOOL_MODE.EXTERNAL_BRIDGE ? EXTERNAL_TOOL_GUARD_MESSAGE : TOOL_GUARD_MESSAGE)
    }
    const finalPrompt = parts.join("\n\n").trim()
    return finalPrompt || undefined
  }

  const normalizeReasoningEffort = (value: unknown, fallback: string | null = null) => {
    if (!value || typeof value !== "string") return fallback
    const effortMap: Record<string, string> = {
      none: "none",
      minimal: "none",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
    }
    return effortMap[value.toLowerCase()] || fallback
  }

  const stripFunctionCalls = (text: string, trim = true) => {
    if (!DISABLE_TOOLS || !text) return text
    return stripFunctionCallMarkup(text, trim)
  }

  const normalizeTextContent = (content: any): string => {
    if (typeof content === "string") return content
    if (Array.isArray(content)) {
      return content
        .map((part: any) => {
          if (typeof part === "string") return part
          if (part && typeof part.text === "string") return part.text
          if (part?.type === "input_text" || part?.type === "output_text" || part?.type === "text") return part?.text || ""
          return ""
        })
        .join("")
    }
    if (content && typeof content.text === "string") return content.text
    if (content === null || content === undefined) return ""
    if (typeof content === "number" || typeof content === "boolean") return String(content)
    return ""
  }

  const normalizeToolArguments = (args: unknown) => {
    if (typeof args === "string") return args
    if (args === undefined) return "{}"
    try {
      return JSON.stringify(args)
    } catch {
      return "{}"
    }
  }

  const createExternalToolContext = (tools: unknown, toolChoice: unknown) => {
    const registry = buildExternalToolRegistry(tools)
    const exposure = buildToolExposure(registry, toolChoice)
    return { registry, exposure, toolChoice: exposure.toolChoice, prompt: exposure.prompt }
  }

  const resolveToolMode = (tools: unknown = [], effectiveInternalAllowlist: string[] = []): ToolMode => {
    if (Array.isArray(tools) && tools.length > 0) return TOOL_MODE.EXTERNAL_BRIDGE
    if (effectiveInternalAllowlist.length > 0) return TOOL_MODE.INTERNAL_ALLOWLIST
    return TOOL_MODE.DISABLED
  }

  const createRequestToolContext = (tools: unknown, toolChoice: unknown, requestOpencodeConfig?: any) => {
    let effectiveInternalAllowlist = SERVER_INTERNAL_ALLOWED_TOOL_NAMES
    let requestInternalAllowlist: string[] | null = null

    if (requestOpencodeConfig && typeof requestOpencodeConfig === "object") {
      if (Array.isArray(requestOpencodeConfig.internal_allowed_tools)) {
        requestInternalAllowlist = requestOpencodeConfig.internal_allowed_tools.map((name: any) => String(name || "").trim()).filter(Boolean)
      }
    }

    if (requestInternalAllowlist !== null) {
      effectiveInternalAllowlist = SERVER_INTERNAL_ALLOWED_TOOL_NAMES.filter((name) => requestInternalAllowlist!.includes(name))
    }

    const deniedRequestedTools = requestInternalAllowlist
      ? requestInternalAllowlist.filter((name) => !SERVER_INTERNAL_ALLOWED_TOOL_NAMES.includes(name))
      : []

    const mode = resolveToolMode(tools, effectiveInternalAllowlist)
    const external =
      mode === TOOL_MODE.EXTERNAL_BRIDGE
        ? createExternalToolContext(tools, toolChoice)
        : {
            registry: [] as ExternalTool[],
            exposure: { tools: [], toolChoice: { mode: "auto", requiredTool: null }, prompt: "" },
            toolChoice: { mode: "auto", requiredTool: null },
            prompt: "",
          }

    return {
      mode,
      external,
      internal: {
        allowedToolNames: effectiveInternalAllowlist,
        requestedAllowlist: requestInternalAllowlist,
        deniedRequestedTools,
        resolutionPath: requestInternalAllowlist ? "request-intersection" : "server-default",
        resultingMode: mode,
      },
    }
  }

  const finalizeValidatedToolCalls = (parsedToolCalls: any[], registry: ExternalTool[]) => {
    const { validCalls, invalidCalls } = validateToolCalls(parsedToolCalls, registry)
    invalidCalls.forEach(({ call, validation }: any) => {
      logDebug("Rejected external tool call", {
        tool: call?.function?.name,
        errors: validation?.errors?.map((error: any) => error.message),
      })
    })
    const allowedCalls: any[] = []
    validCalls.forEach((toolCall) => {
      const policyDecision = evaluateToolPolicy(toolCall.tool, toolCall.validatedArguments, { config: {} })
      if (policyDecision.status === "allow") {
        allowedCalls.push(toolCall)
        return
      }
      logDebug("Blocked external tool call", {
        tool: toolCall.function.name,
        status: policyDecision.status,
        reason: policyDecision.reason,
      })
    })
    return { validCalls: allowedCalls, invalidCalls }
  }

  const toPublicToolCalls = (toolCalls: any[]) => {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return []
    return toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
    }))
  }

  const TOOL_IDS_CACHE_MS = 5 * 60 * 1000
  let cachedToolIds: string[] | null = null
  let cachedToolIdsAt = 0
  let cachedDisabledToolOverrides: Record<string, boolean> | null = null
  let cachedDisabledToolOverridesAt = 0
  const internalToolMetrics = {
    externalBridgeRequests: 0,
    internalAllowlistRequests: 0,
    disabledRequests: 0,
    discoveryFailures: 0,
    fallbackToDisabled: 0,
  }

  const trackToolMode = (toolMode: ToolMode) => {
    if (toolMode === TOOL_MODE.EXTERNAL_BRIDGE) internalToolMetrics.externalBridgeRequests += 1
    else if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) internalToolMetrics.internalAllowlistRequests += 1
    else internalToolMetrics.disabledRequests += 1
  }

  const getBackendToolIds = async (): Promise<string[] | null> => {
    if (cachedToolIds && Date.now() - cachedToolIdsAt < TOOL_IDS_CACHE_MS) return cachedToolIds
    try {
      const idsRes = await client.toolIds()
      const ids = Array.isArray(idsRes?.data) ? idsRes.data : Array.isArray(idsRes) ? idsRes : []
      cachedToolIds = ids
      cachedToolIdsAt = Date.now()
      return ids
    } catch (e: any) {
      internalToolMetrics.discoveryFailures += 1
      logDebug("Backend tool ids failed", { error: e.message })
      return null
    }
  }

  const buildDisabledToolOverrides = (ids: string[] = []) => {
    const overrides: Record<string, boolean> = {}
    ids.forEach((id) => {
      overrides[id] = false
    })
    return overrides
  }

  const normalizeBackendToolIds = (ids: string[] = []) => ids.filter((id) => typeof id === "string" && id.trim())

  // Lowercase and drop separators so `web_fetch`, `WebFetch` and `webfetch` match.
  const normalizeToolName = (name: unknown) => String(name || "").toLowerCase().replace(/[^a-z0-9./]/g, "")

  const matchesAllowedToolName = (toolId: string, allowedToolName: string) => {
    const id = normalizeToolName(toolId)
    const name = normalizeToolName(allowedToolName)
    if (!id || !name) return false
    return id === name || id.endsWith(`.${name}`) || id.endsWith(`/${name}`)
  }

  const resolveInternalAllowedToolIds = (ids: string[] = [], allowedToolNames: string[] = []) => {
    const normalizedIds = normalizeBackendToolIds(ids)
    const normalizedAllowedNames = normalizeConfiguredToolNames(allowedToolNames)
    const matchedToolIds = new Set<string>()
    const unmatchedAllowedNames: string[] = []

    normalizedAllowedNames.forEach((allowedToolName) => {
      const matches = normalizedIds.filter((toolId) => matchesAllowedToolName(toolId, allowedToolName))
      if (matches.length === 0) {
        unmatchedAllowedNames.push(allowedToolName)
        return
      }
      matches.forEach((match) => matchedToolIds.add(match))
    })

    return { normalizedIds, normalizedAllowedNames, matchedToolIds: [...matchedToolIds], unmatchedAllowedNames }
  }

  const getDisabledToolOverrides = async () => {
    if (!DISABLE_TOOLS) return null
    if (cachedDisabledToolOverrides && Date.now() - cachedDisabledToolOverridesAt < TOOL_IDS_CACHE_MS) {
      return cachedDisabledToolOverrides
    }
    const ids = await getBackendToolIds()
    if (!Array.isArray(ids)) return null
    const overrides = buildDisabledToolOverrides(ids)
    cachedDisabledToolOverrides = overrides
    cachedDisabledToolOverridesAt = Date.now()
    return overrides
  }

  // Tool enforcement via the tool-lock plugin (session title carries the policy);
  // backends without the plugin fall back to a per-request `tools` override map.
  const TOOL_LOCK_CHECK_MS = 60 * 1000
  let toolLockState = { loaded: false, checkedAt: 0, warned: false }

  const isToolLockLoaded = async () => {
    if (toolLockState.checkedAt && Date.now() - toolLockState.checkedAt < TOOL_LOCK_CHECK_MS) {
      return toolLockState.loaded
    }
    let plugins: any
    try {
      const res = await client.configGet()
      plugins = Array.isArray(res?.data?.plugin) ? res.data.plugin : []
    } catch {
      return toolLockState.loaded
    }
    const loaded = plugins.some((spec: any) => typeof spec === "string" && spec.replace(/\\/g, "/").endsWith("/opencode2api-tool-lock.js"))
    if (!loaded && !toolLockState.warned) {
      console.warn(
        `[Local] Backend at ${serverUrl} does not load the opencode2api tool-lock plugin; falling back to per-request tool overrides. OpenCode Zen free models reject those requests.`,
      )
      toolLockState.warned = true
    }
    toolLockState = { ...toolLockState, loaded, checkedAt: Date.now() }
    return loaded
  }

  const buildToolPolicy = (toolMode: ToolMode, internalContext: any = {}) => {
    if (toolMode === TOOL_MODE.INTERNAL_ALLOWLIST) {
      const names = normalizeConfiguredToolNames(internalContext.allowedToolNames || SERVER_INTERNAL_ALLOWED_TOOL_NAMES)
        .map(normalizeToolName)
        .filter(Boolean)
      return names.length ? [...new Set(names)].join(",") : "none"
    }
    return DISABLE_TOOLS ? "none" : "*"
  }

  const sessionTitleForPolicy = (policy: string) => `opencode2api [tools:${policy}]`

  const getToolOverridesForMode = async (toolMode: ToolMode, internalContext: any = {}) => {
    if (toolMode === TOOL_MODE.EXTERNAL_BRIDGE || toolMode === TOOL_MODE.DISABLED) {
      return getDisabledToolOverrides()
    }
    if (toolMode !== TOOL_MODE.INTERNAL_ALLOWLIST) return null
    const ids = await getBackendToolIds()
    if (!Array.isArray(ids) || ids.length === 0) return null
    const resolution = resolveInternalAllowedToolIds(ids, internalContext.allowedToolNames || SERVER_INTERNAL_ALLOWED_TOOL_NAMES)
    const { normalizedIds, normalizedAllowedNames, matchedToolIds } = resolution
    if (matchedToolIds.length === 0) {
      internalToolMetrics.fallbackToDisabled += 1
      return buildDisabledToolOverrides(normalizedIds)
    }
    const overrides: Record<string, boolean> = {}
    normalizedIds.forEach((id) => {
      overrides[id] = matchedToolIds.includes(id)
    })
    return overrides
  }

  const resolveToolControl = async (toolMode: ToolMode, internalContext: any = {}) => {
    const policy = buildToolPolicy(toolMode, internalContext)
    if (await isToolLockLoaded()) {
      logDebug("Tool policy via plugin", { toolMode, policy })
      return { title: sessionTitleForPolicy(policy), toolOverrides: null }
    }
    return { title: undefined, toolOverrides: await getToolOverridesForMode(toolMode, internalContext) }
  }

  const createSession = async (toolControl: { title?: string } | null) => {
    const sessionRes = await client.sessionCreate(toolControl?.title ? { body: { title: toolControl.title } } : undefined)
    const sessionId = sessionRes?.data?.id
    if (!sessionId) throw new Error("Failed to create OpenCode session")
    return sessionId as string
  }

  async function promptWithTimeout(promptParams: any, timeoutMs: number) {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs)
    })
    return Promise.race([client.sessionPrompt(promptParams.path.id, promptParams.body), timeoutPromise])
  }

  async function pollForAssistantResponse(sessionId: string, timeoutMs: number, intervalMs = DEFAULT_POLL_INTERVAL_MS) {
    const pollStart = Date.now()
    const startedAt = Date.now()
    let lastPartial: { content: string; reasoning: string; error: any } | null = null
    while (Date.now() - startedAt < timeoutMs) {
      const messagesRes = await client.sessionMessages(sessionId)
      const messages = messagesRes?.data || messagesRes || []
      if (Array.isArray(messages) && messages.length) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          const entry = messages[i]
          const info = entry?.info
          if (info?.role !== "assistant") continue
          const { content, reasoning, toolParts } = extractFromParts(entry?.parts || [])
          const error = info?.error || null
          const finished = info.finish && info.finish !== "tool"
          const done = Boolean(finished || info.time?.completed || error)
          if (toolParts.length > 0) {
            logDebug("Polling found tool parts", { sessionId, count: toolParts.length })
          }
          if (done) {
            if (error) console.error("[Local] OpenCode assistant error:", error)
            logDebug("Polling completed", {
              sessionId,
              ms: Date.now() - pollStart,
              contentLen: content.length,
              reasoningLen: reasoning.length,
            })
            return { content, reasoning, error }
          }
          if (content || reasoning) lastPartial = { content, reasoning, error: null }
          break
        }
      }
      await sleep(intervalMs)
    }
    if (lastPartial) {
      logDebug("Polling timeout with partial response", { sessionId, ms: Date.now() - pollStart })
      return lastPartial
    }
    logDebug("Polling timeout", { sessionId, ms: Date.now() - pollStart })
    throw new Error(`Request timeout after ${timeoutMs}ms`)
  }

  function extractFromParts(parts: any[]) {
    if (!Array.isArray(parts)) return { content: "", reasoning: "", toolParts: [] }
    const content = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("")
    const reasoning = parts
      .filter((p) => p.type === "reasoning")
      .map((p) => p.text)
      .join("")
    const toolParts = parts.filter((p) => p.type === "tool")
    return { content, reasoning, toolParts }
  }

  async function collectFromEvents(
    sessionId: string,
    timeoutMs: number,
    onDelta: ((delta: string, isReasoning: boolean) => void) | null,
    firstDeltaTimeoutMs: number,
    idleTimeoutMs: number,
  ) {
    const controller = new AbortController()
    const eventStreamPromise = client.eventStream(controller.signal)
    let finished = false
    let content = ""
    let reasoning = ""
    let receivedDelta = false
    let deltaChars = 0
    let firstDeltaAt: number | null = null
    const activeToolCallIds = new Set<string>()
    const startedAt = Date.now()

    const finishPromise = new Promise<{ content: string; reasoning: string; noData?: boolean; idleTimeout?: boolean; receivedDelta?: boolean; error?: any }>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (finished) return
        finished = true
        controller.abort()
        reject(new Error(`Request timeout after ${timeoutMs}ms`))
      }, timeoutMs)

      const firstDeltaTimer = firstDeltaTimeoutMs
        ? setTimeout(() => {
            if (finished || receivedDelta) return
            finished = true
            controller.abort()
            logDebug("No event data received", { sessionId, ms: Date.now() - startedAt })
            resolve({ content: "", reasoning: "", noData: true })
          }, firstDeltaTimeoutMs)
        : null

      let idleTimer: ReturnType<typeof setTimeout> | null = null
      const scheduleIdleTimer = () => {
        if (!idleTimeoutMs) return
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          if (finished) return
          if (activeToolCallIds.size > 0) {
            logDebug("Event idle while internal tool call is active, continuing to wait", {
              sessionId,
              ms: Date.now() - startedAt,
              activeTools: activeToolCallIds.size,
            })
            scheduleIdleTimer()
            return
          }
          finished = true
          controller.abort()
          logDebug("Event idle timeout", { sessionId, ms: Date.now() - startedAt, deltaChars })
          resolve({ content, reasoning, idleTimeout: true, receivedDelta })
        }, idleTimeoutMs)
      }

      const trackToolActivity = (part: any) => {
        if (!part || part.type !== "tool") return
        const status = part.state?.status
        if (status === "pending" || status === "running") {
          if (part.id) activeToolCallIds.add(part.id)
        } else if (status === "completed" || status === "error") {
          if (part.id) activeToolCallIds.delete(part.id)
        }
        receivedDelta = true
        if (firstDeltaTimer) clearTimeout(firstDeltaTimer)
        scheduleIdleTimer()
      }

      const partTypeById = new Map<string, string>()
      const rememberPartType = (part: any) => {
        if (part && part.id && typeof part.type === "string") partTypeById.set(part.id, part.type)
      }
      const applyTextDelta = (partType: string | undefined, delta: string) => {
        receivedDelta = true
        if (firstDeltaTimer) clearTimeout(firstDeltaTimer)
        scheduleIdleTimer()
        if (!firstDeltaAt) {
          firstDeltaAt = Date.now()
          logDebug("SSE first delta", { sessionId, ms: firstDeltaAt - startedAt, type: partType })
        }
        if (partType === "reasoning") {
          reasoning += delta
          if (onDelta) onDelta(delta, true)
        } else {
          content += delta
          if (onDelta) onDelta(delta, false)
        }
        deltaChars += delta.length
      }

      ;(async () => {
        try {
          for await (const event of await eventStreamPromise) {
            if (event.type === "message.part.updated" && event.properties?.part?.sessionID === sessionId) {
              const { part, delta } = event.properties
              rememberPartType(part)
              trackToolActivity(part)
              if (delta) applyTextDelta(part.type, delta)
              continue
            }
            if (event.type === "message.part.delta" && event.properties?.sessionID === sessionId) {
              const { partID, delta, field } = event.properties
              if (typeof delta === "string" && field === "text") {
                const partType = partTypeById.get(partID)
                if (partType === "reasoning" || partType === "text") {
                  applyTextDelta(partType, delta)
                }
              }
              continue
            }
            if (event.type === "message.updated" && event.properties?.info?.sessionID === sessionId) {
              const info = event.properties.info
              const finish = info.finish
              if (info.error && !finished) {
                finished = true
                clearTimeout(timeoutId)
                if (firstDeltaTimer) clearTimeout(firstDeltaTimer)
                if (idleTimer) clearTimeout(idleTimer)
                logDebug("SSE upstream message error", {
                  sessionId,
                  ms: Date.now() - startedAt,
                  error: info.error.name || "UnknownError",
                })
                resolve({ content, reasoning, error: info.error })
                break
              }
              if (Array.isArray(info.parts)) {
                for (const part of info.parts) {
                  rememberPartType(part)
                  if (part && part.type === "tool") {
                    const status = part.state?.status
                    if (status === "pending" || status === "running") {
                      if (part.id) activeToolCallIds.add(part.id)
                    } else if (status === "completed" || status === "error") {
                      if (part.id) activeToolCallIds.delete(part.id)
                    }
                  }
                }
              }
              if (finish === "tool") {
                if (firstDeltaTimer) clearTimeout(firstDeltaTimer)
                scheduleIdleTimer()
                continue
              }
              if (finish === "stop") {
                if (activeToolCallIds.size > 0) {
                  logDebug("Ignoring intermediate stop while tools are active", { sessionId, activeTools: activeToolCallIds.size })
                  continue
                }
                if (!finished) {
                  finished = true
                  clearTimeout(timeoutId)
                  if (firstDeltaTimer) clearTimeout(firstDeltaTimer)
                  if (idleTimer) clearTimeout(idleTimer)
                  logDebug("SSE completed", { sessionId, ms: Date.now() - startedAt, deltaChars })
                  resolve({ content, reasoning })
                }
                break
              }
            }
          }
        } catch (e) {
          if (!finished) {
            finished = true
            clearTimeout(timeoutId)
            if (firstDeltaTimer) clearTimeout(firstDeltaTimer)
            if (idleTimer) clearTimeout(idleTimer)
            reject(e)
          }
        }
      })()
    })

    try {
      return await finishPromise
    } finally {
      controller.abort()
    }
  }

  // --- conversation cleanup ------------------------------------------------

  const getCleanupRoots = () => {
    const roots: string[] = []
    const add = (dir: string | null | undefined) => {
      if (!dir) return
      if (!roots.includes(dir)) roots.push(dir)
    }
    add("/home/node/.local/share/opencode/storage")
    return roots
  }

  const cleanupConversationFiles = async () => {
    if (!AUTO_CLEANUP_CONVERSATIONS) return { removed: 0, scanned: 0 }
    const now = Date.now()
    let removed = 0
    let scanned = 0
    for (const storageRoot of getCleanupRoots()) {
      for (const sub of ["message", "session"]) {
        const dir = path.join(storageRoot, sub)
        if (!fs.existsSync(dir)) continue
        let entries: fs.Dirent[] = []
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name)
          let stat: fs.Stats
          try {
            stat = fs.statSync(full)
          } catch {
            continue
          }
          scanned += 1
          const mtime = stat.mtimeMs || stat.ctimeMs || now
          if (now - mtime < CLEANUP_MAX_AGE_MS) continue
          try {
            fs.rmSync(full, { recursive: true, force: true })
            removed += 1
          } catch (e: any) {
            logDebug("Cleanup remove failed", { full, error: e.message })
          }
        }
      }
    }
    if (removed > 0) logDebug("Conversation cleanup completed", { removed, scanned, maxAgeMs: CLEANUP_MAX_AGE_MS })
    return { removed, scanned }
  }

  if (AUTO_CLEANUP_CONVERSATIONS) {
    setTimeout(() => {
      cleanupConversationFiles().catch((e) => logDebug("Cleanup run failed", { error: e.message }))
    }, 3000)
    const cleanupTimer = setInterval(() => {
      cleanupConversationFiles().catch((e) => logDebug("Cleanup run failed", { error: e.message }))
    }, CLEANUP_INTERVAL_MS)
    if (cleanupTimer.unref) cleanupTimer.unref()
  }

  // --- shared request setup ------------------------------------------------

  const ensureBackendOnce = async () => {
    const backendConfig: EnsureBackendConfig = {
      serverUrl,
      opencodePath: config.opencodePath,
      useIsolatedHome: config.useIsolatedHome,
      zenApiKey: config.zenApiKey,
      serverPassword: config.serverPassword,
      manageBackend: config.manageBackend,
      promptMode: PROMPT_MODE,
      toolLockPluginPath: config.toolLockPluginPath,
    }
    await ensureBackend(backendConfig)
  }

  function createForcedToolCallRequester({
    mode,
    sessionId,
    systemWithGuard,
    requiredTool,
    providerID,
    modelID,
    toolOverrides,
    requestTimeoutMs,
    forbidThinkBlock = false,
  }: any) {
    return async () => {
      if (mode !== "required") return null
      if (!requiredTool) return null
      const forcedPromptParams = {
        path: { id: sessionId },
        body: {
          model: { providerID, modelID },
          ...(systemWithGuard ? { system: systemWithGuard } : {}),
          parts: [
            {
              type: "text",
              text: `SYSTEM: Your previous reply did not emit the required external tool call. Reply now with ONLY <function_calls>{\\"name\\":\\"${requiredTool}\\",\\"arguments\\":{}}</function_calls> or an array inside <function_calls>...</function_calls>. Do not output any prose, reasoning, markdown${forbidThinkBlock ? ", or <think> block" : ""}. Infer the correct arguments from the conversation so far.`,
            },
          ],
        },
      }
      if (toolOverrides && Object.keys(toolOverrides).length > 0) {
        ;(forcedPromptParams.body as any).tools = toolOverrides
      }
      await promptWithTimeout(forcedPromptParams, requestTimeoutMs)
      return pollForAssistantResponse(sessionId, requestTimeoutMs)
    }
  }

  // --- chat completions ----------------------------------------------------

  async function handleChat(body: any, requestStream: boolean): Promise<Response> {
    try {
      return (await lock(async () => {
        let sessionId: string | null = null

        try {
          const { messages, model, tools = [], tool_choice, temperature, max_tokens, top_p, stop, reasoning_effort, reasoning: requestReasoning, opencode: requestOpencodeConfig } = body ?? {}
          if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return jsonResponse({ error: { message: "messages array is required" } }, 400)
          }

          const stream = Boolean(requestStream)
          const reasoningLevel = normalizeReasoningEffort(reasoning_effort || requestReasoning?.effort, null)

          const requestParams = {
            temperature: typeof temperature === "number" ? temperature : 0.7,
            max_tokens: typeof max_tokens === "number" ? max_tokens : null,
            top_p: typeof top_p === "number" ? top_p : 1.0,
            stop: Array.isArray(stop) ? stop : stop ? [stop] : null,
            reasoning_effort: reasoningLevel,
          }

          const resolvedModel = await resolveRequestedModel(model)
          const pID = resolvedModel.providerID
          const mID = resolvedModel.modelID
          if (resolvedModel.aliasFrom) {
            logDebug("Resolved model alias", { from: resolvedModel.aliasFrom, to: resolvedModel.resolved })
          }

          const normalizeMessageContent = (content: any) => normalizeTextContent(content)

          const buildPromptParts = async (rawMessages: any[], externalToolRegistry: ExternalTool[]) => {
            const parts: any[] = []
            const systemChunks: string[] = []
            const userContents: string[] = []
            const assistantToolCalls = new Map<string, string>()
            const formatRoleLine = (role: string, name: string | undefined, text: string) => {
              const roleLabel = role.toUpperCase()
              const nameSuffix = name ? `(${name})` : ""
              return `${roleLabel}${nameSuffix}: ${text}`
            }

            for (const m of rawMessages) {
              const role = (m?.role || "user").toLowerCase()
              const content = m?.content

              if (role === "system") {
                const text = normalizeMessageContent(content)
                if (text) systemChunks.push(text)
                continue
              }

              if (role === "assistant" && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
                const serializedToolCalls = m.tool_calls
                  .map((toolCall: any, index: number) => ({
                    id: toolCall?.id || `call_${index + 1}`,
                    name:
                      findExternalToolByName(externalToolRegistry, toolCall?.function?.name || toolCall?.name)?.namespacedName ||
                      toolCall?.function?.name ||
                      toolCall?.name,
                    arguments: normalizeToolArguments(toolCall?.function?.arguments ?? toolCall?.arguments),
                  }))
                  .filter((toolCall: any) => toolCall.name)
                if (serializedToolCalls.length) {
                  serializedToolCalls.forEach((toolCall: any) => {
                    assistantToolCalls.set(toolCall.id, toolCall.name)
                  })
                  parts.push({
                    type: "text",
                    text: `ASSISTANT: <function_calls>${JSON.stringify(serializedToolCalls)}</function_calls>`,
                  })
                }
              }

              if (role === "tool") {
                const text = normalizeMessageContent(content)
                if (text) {
                  const mappedTool =
                    findExternalToolByName(externalToolRegistry, m?.name) ||
                    findExternalToolByName(externalToolRegistry, assistantToolCalls.get(m?.tool_call_id))
                  const toolName = mappedTool?.namespacedName || assistantToolCalls.get(m?.tool_call_id) || m?.name || `${EXTERNAL_TOOL_PREFIX}unknown`
                  const toolCallId = m?.tool_call_id || `call_${toolName.replace(/[^a-zA-Z0-9_]/g, "_")}`
                  parts.push({
                    type: "text",
                    text: `TOOL_RESULT: ${JSON.stringify({ tool_call_id: toolCallId, name: toolName, content: text })}`,
                  })
                }
                continue
              }

              if (!content) continue

              if (typeof content === "string") {
                if (role === "user") userContents.push(content)
                parts.push({ type: "text", text: formatRoleLine(role, m?.name, content) })
              } else if (Array.isArray(content)) {
                for (const part of content) {
                  if (!part) continue
                  if (part.type === "text") {
                    const text = part.text || ""
                    if (role === "user") userContents.push(text)
                    parts.push({ type: "text", text: formatRoleLine(role, m?.name, text) })
                  } else if (part.type === "image_url") {
                    const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
                    if (imageUrl) {
                      try {
                        const dataUri = await getImageDataUri(imageUrl)
                        const mime = dataUri.split(";")[0].split(":")[1]
                        parts.push({ type: "file", mime, url: dataUri, filename: "image" })
                      } catch (imgErr: any) {
                        console.warn("[Local] Skipping image due to error:", imgErr.message)
                      }
                    }
                  }
                }
              }
            }

            return {
              parts,
              system: systemChunks.join("\n\n"),
              fullPromptText: parts.map((p) => p.text).join("\n\n"),
              lastUserMsg: userContents[userContents.length - 1] || "",
            }
          }

          const requestToolContext = createRequestToolContext(tools, tool_choice, requestOpencodeConfig)
          const toolMode = requestToolContext.mode
          const externalToolContext = requestToolContext.external
          const externalToolRegistry = externalToolContext.registry
          const externalToolChoice = externalToolContext.toolChoice
          const internalToolContext = requestToolContext.internal
          trackToolMode(toolMode)

          const { parts, system: systemMsg, fullPromptText } = await buildPromptParts(messages, externalToolRegistry)
          const systemWithGuard = buildSystemPrompt(
            [systemMsg, externalToolContext.prompt].filter(Boolean).join("\n\n"),
            requestParams.reasoning_effort,
            toolMode,
            internalToolContext.allowedToolNames,
          )
          if (!parts.length) {
            return jsonResponse({ error: { message: "messages must include at least one non-system text message" } }, 400)
          }

          await ensureBackendOnce()

          try {
            await client.configUpdate({ body: { activeModel: { providerID: pID, modelID: mID } } })
          } catch (confError: any) {
            logDebug("Failed to set active model:", confError.message)
          }

          const toolControl = await resolveToolControl(toolMode, internalToolContext)
          sessionId = await createSession(toolControl)
          logDebug("Session created", { sessionId })

          const id = `chatcmpl-${crypto.randomUUID()}`
          let completionTokens = 0
          let reasoningTokens = 0

          const promptParams = {
            path: { id: sessionId },
            body: {
              model: { providerID: pID, modelID: mID },
              system: systemWithGuard,
              // Append the contract reminder as the last part so the model sees it
              // immediately before generating (position matters for compliance).
              parts: externalToolContext.reminder ? [...parts, { type: "text", text: externalToolContext.reminder }] : parts,
              ...(requestParams.max_tokens && { max_tokens: requestParams.max_tokens }),
              ...(requestParams.temperature !== undefined && { temperature: requestParams.temperature }),
              ...(requestParams.top_p !== undefined && { top_p: requestParams.top_p }),
              ...(requestParams.stop && { stop: requestParams.stop }),
            },
          }
          const { toolOverrides } = toolControl
          if (toolOverrides && Object.keys(toolOverrides).length > 0) {
            ;(promptParams.body as any).tools = toolOverrides
          }

          const makeForcedChatToolCallRequester = () =>
            createForcedToolCallRequester({
              mode: externalToolChoice.mode,
              sessionId,
              systemWithGuard,
              requiredTool: externalToolChoice.requiredTool || externalToolRegistry[0]?.namespacedName,
              providerID: pID,
              modelID: mID,
              toolOverrides,
              requestTimeoutMs: REQUEST_TIMEOUT_MS,
              forbidThinkBlock: true,
            })
          let requestForcedChatToolCall = makeForcedChatToolCallRequester()

          const finalizeStream = (finalStreamedToolCalls: any[]) => {
            const promptTokens = Math.ceil((fullPromptText || "").length / 4)
            const totalTokens = promptTokens + completionTokens + reasoningTokens
            return [
              `data: ${JSON.stringify({
                id,
                choices: [{ index: 0, delta: {}, finish_reason: finalStreamedToolCalls.length > 0 ? "tool_calls" : "stop" }],
                usage: {
                  prompt_tokens: promptTokens,
                  completion_tokens: completionTokens + reasoningTokens,
                  total_tokens: totalTokens,
                  completion_tokens_details: { reasoning_tokens: reasoningTokens },
                },
              })}\n\n`,
              "data: [DONE]\n\n",
            ]
          }

          if (stream) {
            const shouldStripStreamingToolMarkup = externalToolRegistry.length > 0
            const filterContentDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup })
            const filterReasoningDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup })
            const parseContentToolCalls = createExternalToolCallStreamParser(externalToolRegistry)
            const parseReasoningToolCalls = createExternalToolCallStreamParser(externalToolRegistry)
            let streamedContent = ""
            let streamedReasoning = ""
            let rawStreamedContent = ""
            let rawStreamedReasoning = ""
            const streamedToolCalls: any[] = []
            completionTokens = 0
            reasoningTokens = 0

            // Push-based SSE: collectFromEvents emits deltas from async callbacks, so
            // frames are enqueued directly instead of pulled from a generator.
            let sink: ((frame: string) => void) | null = null
            let keepaliveTimer: ReturnType<typeof setInterval> | null = null
            const encoderChunk = (payload: any) => `data: ${JSON.stringify(payload)}\n\n`
            const sendDelta = (delta: string, isReasoning = false) => {
              if (!delta) return
              if (isReasoning) rawStreamedReasoning += delta
              else rawStreamedContent += delta
              const parsedDeltaToolCalls = isReasoning ? parseReasoningToolCalls(delta) : parseContentToolCalls(delta)
              parsedDeltaToolCalls.forEach((toolCall: any) => {
                streamedToolCalls.push(toolCall)
                sink?.(
                  encoderChunk({
                    id,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: `${pID}/${mID}`,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: streamedToolCalls.length - 1,
                              id: toolCall.id,
                              type: "function",
                              function: { name: toolCall.function.name, arguments: toolCall.function.arguments },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  }),
                )
              })
              const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta)
              if (!filtered) return
              if (isReasoning) {
                streamedReasoning += filtered
                reasoningTokens += Math.ceil(filtered.length / 4)
              } else {
                streamedContent += filtered
                completionTokens += Math.ceil(filtered.length / 4)
              }
              const deltaField = isReasoning ? { reasoning_content: filtered } : { content: filtered }
              sink?.(
                encoderChunk({
                  id,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: `${pID}/${mID}`,
                  choices: [{ index: 0, delta: deltaField, finish_reason: null }],
                }),
              )
            }

            const runStream = async (emit: (frame: string) => void) => {
              sink = emit
              if (!keepaliveTimer) {
                keepaliveTimer = setInterval(() => sink?.(": keepalive\n\n"), 15000)
              }
              let collected: any = null
              for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
                if (attempt > 1) {
                  try {
                    await client.sessionDelete(sessionId!)
                  } catch (e: any) {
                    logDebug("Failed to delete retried session", { sessionId, error: e.message })
                  }
                  sessionId = await createSession(toolControl)
                  promptParams.path.id = sessionId
                  requestForcedChatToolCall = makeForcedChatToolCallRequester()
                  streamedContent = ""
                  streamedReasoning = ""
                  rawStreamedContent = ""
                  rawStreamedReasoning = ""
                  streamedToolCalls.length = 0
                  completionTokens = 0
                  reasoningTokens = 0
                  await sleep(RETRY_BACKOFF_BASE_MS * attempt)
                }
                try {
                  const collectPromise = collectFromEvents(sessionId!, REQUEST_TIMEOUT_MS, sendDelta, EVENT_FIRST_DELTA_TIMEOUT_MS, EVENT_IDLE_TIMEOUT_MS)
                  const safeCollect = collectPromise.catch((err) => ({ __error: err }))
                  client.sessionPrompt(promptParams.path.id, promptParams.body).catch((err: any) => logDebug("Prompt error:", err.message))
                  collected = await safeCollect
                } catch (e: any) {
                  logDebug("Stream error:", e.message)
                }

                const attemptError = collected?.error || collected?.__error || null
                const nothingStreamed = !rawStreamedContent && !rawStreamedReasoning && streamedToolCalls.length === 0
                if (attemptError && nothingStreamed && attempt < RETRY_MAX_ATTEMPTS && isTransientUpstreamError(attemptError)) {
                  console.warn(
                    `[Local] Transient upstream error (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}), retrying:`,
                    attemptError.data?.message || attemptError.message || attemptError.name || "unknown",
                  )
                  continue
                }
                break
              }

              const pollFallback = async () => {
                const { content, reasoning: pollReasoning, error } = await pollForAssistantResponse(sessionId!, REQUEST_TIMEOUT_MS)
                if (error && !content && !pollReasoning) {
                  sendDelta(`[Proxy Error] ${error.name || "OpenCodeError"}: ${error.data?.message || error.message || "Unknown error"}`)
                } else {
                  if (pollReasoning) sendDelta(pollReasoning, true)
                  if (content) sendDelta(content, false)
                }
              }

              if (collected && collected.__error) {
                logDebug("SSE collect error, falling back to polling", { sessionId, error: collected.__error?.message })
                await pollFallback()
              } else if (collected && collected.noData) {
                logDebug("Fallback to polling (stream)", { sessionId })
                await pollFallback()
              } else if (collected && collected.idleTimeout) {
                logDebug("SSE idle timeout, polling for completion", { sessionId })
                const { content, reasoning: polledReasoning, error } = await pollForAssistantResponse(sessionId!, REQUEST_TIMEOUT_MS)
                if (error && !content && !polledReasoning) {
                  sendDelta(`[Proxy Error] ${error.name || "OpenCodeError"}: ${error.data?.message || error.message || "Unknown error"}`)
                } else {
                  const remainingReasoning = polledReasoning && polledReasoning.startsWith(rawStreamedReasoning) ? polledReasoning.slice(rawStreamedReasoning.length) : polledReasoning
                  const remainingContent = content && content.startsWith(rawStreamedContent) ? content.slice(rawStreamedContent.length) : content
                  if (remainingReasoning) sendDelta(remainingReasoning, true)
                  if (remainingContent) sendDelta(remainingContent, false)
                }
              }

              if (collected && !streamedContent && !streamedReasoning && (collected.reasoning || collected.content)) {
                if (collected.reasoning) sendDelta(collected.reasoning, true)
                if (collected.content) sendDelta(collected.content, false)
              }

              if (!streamedContent && !streamedReasoning) {
                logDebug("SSE returned empty, falling back to polling", { sessionId })
                await pollFallback()
              } else if (streamedReasoning && !streamedContent) {
                // Reasoning streamed but no content: recover the answer from the snapshot.
                logDebug("Reasoning streamed but no content, reconciling from snapshot", { sessionId })
                const snapshot = await pollForAssistantResponse(sessionId!, REQUEST_TIMEOUT_MS).catch(() => null)
                if (snapshot && snapshot.content) {
                  const remainingContent = rawStreamedContent ? snapshot.content.slice(rawStreamedContent.length) : snapshot.content
                  if (remainingContent) sendDelta(remainingContent, false)
                }
              }

              const flushedReasoningCalls = parseReasoningToolCalls.flush ? parseReasoningToolCalls.flush() : []
              const flushedContentCalls = parseContentToolCalls.flush ? parseContentToolCalls.flush() : []
              const flushedReasoningText = filterReasoningDelta.flush ? filterReasoningDelta.flush() : ""
              const flushedContentText = filterContentDelta.flush ? filterContentDelta.flush() : ""
              const finalReasoningText = rawStreamedReasoning + flushedReasoningText
              const finalContentText = rawStreamedContent + flushedContentText

              const parseStreamedToolCalls = () => {
                if (externalToolRegistry.length === 0) return []
                const perChannel = [
                  ...flushedReasoningCalls,
                  ...flushedContentCalls,
                  ...parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText, finalContentText),
                ]
                if (perChannel.length > 0) return perChannel
                return parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText + finalContentText)
              }

              let parsedToolCalls = streamedToolCalls.length > 0 ? streamedToolCalls : parseStreamedToolCalls()
              if (parsedToolCalls.length === 0 && externalToolChoice.mode === "required") {
                const forcedResponse = await requestForcedChatToolCall()
                if (forcedResponse) {
                  parsedToolCalls = parseExternalToolCallsFromText(externalToolRegistry, forcedResponse.reasoning, forcedResponse.content)
                }
              }
              const { validCalls: validatedStreamedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry)
              const finalStreamedToolCalls = validatedStreamedToolCalls
              if (finalStreamedToolCalls.length > 0) {
                const toolCallDeltas = finalStreamedToolCalls.map((toolCall: any, index: number) => ({
                  index,
                  id: toolCall.id,
                  type: "function",
                  function: { name: toolCall.function.name, arguments: toolCall.function.arguments },
                }))
                emit(
                  encoderChunk({
                    id,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: `${pID}/${mID}`,
                    choices: [{ index: 0, delta: { tool_calls: toolCallDeltas }, finish_reason: null }],
                  }),
                )
              }

              for (const tail of finalizeStream(finalStreamedToolCalls)) emit(tail)
              if (keepaliveTimer) {
                clearInterval(keepaliveTimer)
                keepaliveTimer = null
              }
            }

            return sseResponse(runStream)
          }

          // Non-stream path
          let content = ""
          let reasoning = ""
          let assistantError: any = null
          for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt += 1) {
            if (attempt > 1) {
              try {
                await client.sessionDelete(sessionId!)
              } catch (e: any) {
                logDebug("Failed to delete retried session", { sessionId, error: e.message })
              }
              sessionId = await createSession(toolControl)
              promptParams.path.id = sessionId
              requestForcedChatToolCall = makeForcedChatToolCallRequester()
              await sleep(RETRY_BACKOFF_BASE_MS * attempt)
            }
            await promptWithTimeout(promptParams, REQUEST_TIMEOUT_MS)
            const collected = await pollForAssistantResponse(sessionId!, REQUEST_TIMEOUT_MS)
            content = collected.content || ""
            reasoning = collected.reasoning || ""
            assistantError = collected.error || null
            if (assistantError && !content && !reasoning && attempt < RETRY_MAX_ATTEMPTS && isTransientUpstreamError(assistantError)) {
              console.warn(
                `[Local] Transient upstream error (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}), retrying:`,
                assistantError.data?.message || assistantError.message || assistantError.name || "unknown",
              )
              continue
            }
            break
          }
          if (assistantError && !content && !reasoning) {
            return jsonResponse(
              {
                error: {
                  message: assistantError.data?.message || assistantError.message || "OpenCode provider error",
                  type: assistantError.name || "OpenCodeError",
                },
              },
              502,
            )
          }
          let parsedToolCalls =
            externalToolRegistry.length > 0 ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content) : []
          if (parsedToolCalls.length === 0 && externalToolChoice.mode === "required") {
            const forcedResponse = await requestForcedChatToolCall()
            if (forcedResponse) {
              content = forcedResponse.content || content
              reasoning = forcedResponse.reasoning || reasoning
              parsedToolCalls = parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
            }
          }
          const { validCalls: validatedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry)
          const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content))
          const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning))

          const promptTokens = Math.ceil((fullPromptText || "").length / 4)
          const completionTokensCalc = Math.ceil((content || "").length / 4)
          const reasoningTokensCalc = Math.ceil((reasoning || "").length / 4)
          const totalTokens = promptTokens + completionTokensCalc + reasoningTokensCalc

          const publicValidatedToolCalls = toPublicToolCalls(validatedToolCalls)
          const assistantMessage: any = {
            role: "assistant",
            content: publicValidatedToolCalls.length > 0 ? (safeContent || null) : safeContent,
            ...(safeReasoning ? { reasoning_content: safeReasoning } : {}),
          }
          if (publicValidatedToolCalls.length > 0) {
            assistantMessage.tool_calls = publicValidatedToolCalls
          }

          return jsonResponse({
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: `${pID}/${mID}`,
            choices: [{ index: 0, message: assistantMessage, finish_reason: publicValidatedToolCalls.length > 0 ? "tool_calls" : "stop" }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokensCalc + reasoningTokensCalc,
              total_tokens: totalTokens,
              completion_tokens_details: { reasoning_tokens: reasoningTokensCalc },
            },
          })
        } catch (error: any) {
          console.error("[Local] API Error:", error.message)
          if (sessionId) {
            try {
              await client.sessionDelete(sessionId)
            } catch (e: any) {
              console.error("[Local] Failed to cleanup session on error:", e.message)
            }
          }
          return errorResponse(transformUpstreamError(error))
        }
      }, REQUEST_TIMEOUT_MS + 20000))
    } catch (error: any) {
      console.error("[Local] Request Handler Error:", error.message)
      return jsonResponse({ error: { message: error.message, type: error.constructor?.name ?? "Error" } }, 500)
    }
  }

  // --- responses API -------------------------------------------------------

  async function handleResponses(body: any, requestStream: boolean): Promise<Response> {
    try {
      const {
        model,
        input,
        reasoning_effort,
        reasoning: requestReasoning,
        max_output_tokens,
        tools = [],
        tool_choice,
        instructions,
        temperature,
        top_p,
        stream = false,
        messages: chatMessages,
        prompt,
        previous_response_id: previousResponseId,
        opencode: requestOpencodeConfig,
      } = body ?? {}

      const previousState = previousResponseId ? getResponseState(previousResponseId) : null
      if (previousResponseId && !previousState) {
        return jsonResponse({ error: { message: "Invalid or expired previous_response_id" } }, 400)
      }

      const reasoningLevel = normalizeReasoningEffort(reasoning_effort || requestReasoning?.effort, null)

      const requestToolContext = createRequestToolContext(tools, tool_choice, requestOpencodeConfig)
      const toolMode = requestToolContext.mode
      const internalToolContext = requestToolContext.internal
      trackToolMode(toolMode)
      const externalToolContext = requestToolContext.external
      const externalToolRegistry = externalToolContext.registry
      const externalToolChoice = externalToolContext.toolChoice
      const assistantToolCalls = new Map<string, string>()

      const rememberAssistantToolCall = (toolCallId: string, toolName: string) => {
        if (!toolCallId || !toolName) return
        assistantToolCalls.set(toolCallId, toolName)
      }

      const buildResponsesToolResultLine = (item: any = {}) => {
        const text = item?.content ?? item?.output ?? item?.result ?? item?.text
        const normalizedText = typeof text === "string" ? text : text ? JSON.stringify(text) : ""
        if (!normalizedText) return null
        const mappedTool =
          findExternalToolByName(externalToolRegistry, item?.name) ||
          findExternalToolByName(externalToolRegistry, assistantToolCalls.get(item?.call_id || item?.tool_call_id))
        const toolName = mappedTool?.namespacedName || assistantToolCalls.get(item?.call_id || item?.tool_call_id) || item?.name || `${EXTERNAL_TOOL_PREFIX}unknown`
        const toolCallId = item?.call_id || item?.tool_call_id || `call_${toolName.replace(/[^a-zA-Z0-9_]/g, "_")}`
        rememberAssistantToolCall(toolCallId, toolName)
        return `TOOL_RESULT: ${JSON.stringify({ tool_call_id: toolCallId, name: toolName, content: normalizedText })}`
      }

      const buildResponsesAssistantToolCallsLine = (item: any = {}) => {
        const sourceCalls = Array.isArray(item?.tool_calls) ? item.tool_calls : item?.type === "function_call" ? [item] : []
        if (!sourceCalls.length) return null
        const serializedToolCalls = sourceCalls
          .map((toolCall: any, index: number) => {
            const rawName = toolCall?.function?.name || toolCall?.name
            const mappedTool = findExternalToolByName(externalToolRegistry, rawName)
            const namespacedName = mappedTool?.namespacedName || rawName
            if (!namespacedName) return null
            const toolCallId = toolCall?.call_id || toolCall?.id || `call_${index + 1}`
            rememberAssistantToolCall(toolCallId, namespacedName)
            return {
              id: toolCallId,
              name: namespacedName,
              arguments: normalizeToolArguments(toolCall?.arguments ?? toolCall?.function?.arguments),
            }
          })
          .filter(Boolean)
        if (!serializedToolCalls.length) return null
        return `ASSISTANT: <function_calls>${JSON.stringify(serializedToolCalls)}</function_calls>`
      }

      const buildResponsesInputMessages = (rawItems: any[]) => {
        const normalized: any[] = []
        if (!Array.isArray(rawItems)) return normalized
        for (const item of rawItems) {
          if (!item) continue

          if (item.type === "function_call_output" || item.type === "tool_result" || item.role === "tool") {
            const toolResultLine = buildResponsesToolResultLine(item)
            if (toolResultLine) normalized.push({ role: "tool", content: toolResultLine })
            continue
          }

          if (item.type === "function_call") {
            const assistantToolCallsLine = buildResponsesAssistantToolCallsLine(item)
            if (assistantToolCallsLine) normalized.push({ role: "assistant", content: assistantToolCallsLine, isToolCalls: true })
            continue
          }

          if (item.role === "assistant" && Array.isArray(item?.tool_calls) && item.tool_calls.length) {
            const assistantToolCallsLine = buildResponsesAssistantToolCallsLine(item)
            if (assistantToolCallsLine) normalized.push({ role: "assistant", content: assistantToolCallsLine, isToolCalls: true })
          }

          if (item.type === "message") {
            const role = item.role || "user"
            const content = normalizeTextContent(item.content)
            if (content) normalized.push({ role, content })
            continue
          }

          if (item.type === "input_text") {
            if (item.text) normalized.push({ role: "user", content: item.text })
            continue
          }

          const text = normalizeTextContent(item.content || item.text)
          if (text) normalized.push({ role: item.role || "user", content: text })
        }
        return normalized
      }

      let messages: any[] = []
      if (Array.isArray(chatMessages) && chatMessages.length) {
        messages = buildResponsesInputMessages(chatMessages)
      } else if (typeof prompt === "string" && prompt.trim()) {
        messages = [{ role: "user", content: prompt }]
      } else if (typeof input === "string") {
        messages = [{ role: "user", content: input }]
      } else if (Array.isArray(input)) {
        messages = buildResponsesInputMessages(input)
      } else if (input && typeof input === "object") {
        if (input.type === "message" || input.type === "function_call" || input.type === "function_call_output" || input.type === "tool_result") {
          messages = buildResponsesInputMessages([input])
        } else {
          const content = normalizeTextContent(input.content || input.text)
          if (content) messages = [{ role: input.role || "user", content }]
        }
      }

      if (!messages.length) {
        return jsonResponse({ error: { message: "input is required" } }, 400)
      }

      const resolvedModel = await resolveRequestedModel(model || previousState?.model)
      const pID = resolvedModel.providerID
      const mID = resolvedModel.modelID

      await ensureBackendOnce()

      try {
        await client.configUpdate({ body: { activeModel: { providerID: pID, modelID: mID } } })
      } catch {}

      const toolControl = await resolveToolControl(toolMode, internalToolContext)
      let sessionId = previousState?.sessionId || null
      if (!sessionId) {
        sessionId = await createSession(toolControl)
      }

      const parts: any[] = []
      const systemChunks: string[] = []
      let fullPromptText = ""
      const formatResponsesRoleLine = (role: string, text: string) => `${String(role || "user").toUpperCase()}: ${text}`
      for (const msg of messages) {
        if (msg.role === "system") {
          if (msg.content) systemChunks.push(msg.content)
          continue
        }
        if (!msg.content) continue
        const text =
          msg.role === "tool" ||
          String(msg.content).startsWith("ASSISTANT: ") ||
          String(msg.content).startsWith("TOOL_RESULT: ")
            ? msg.content
            : msg.role === "user"
              ? msg.content
              : formatResponsesRoleLine(msg.role, msg.content)
        parts.push({ type: "text", text })
        fullPromptText += `${text}\n\n`
      }

      const systemWithGuard = buildSystemPrompt(
        [instructions, ...systemChunks, externalToolContext.prompt].filter(Boolean).join("\n\n"),
        reasoningLevel,
        toolMode,
        internalToolContext.allowedToolNames,
      )

      const requestForcedResponsesToolCall = createForcedToolCallRequester({
        mode: externalToolChoice.mode,
        sessionId,
        systemWithGuard,
        requiredTool: externalToolChoice.requiredTool || externalToolRegistry[0]?.namespacedName,
        providerID: pID,
        modelID: mID,
        toolOverrides: toolControl.toolOverrides,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        forbidThinkBlock: false,
      })

      const promptParams = {
        path: { id: sessionId },
        body: {
          model: { providerID: pID, modelID: mID },
          ...(systemWithGuard ? { system: systemWithGuard } : {}),
          parts: externalToolContext.reminder ? [...parts, { type: "text", text: externalToolContext.reminder }] : parts,
          ...(max_output_tokens && { max_tokens: max_output_tokens }),
          ...(temperature !== undefined && { temperature }),
          ...(top_p !== undefined && { top_p }),
        },
      }
      const { toolOverrides } = toolControl
      if (toolOverrides && Object.keys(toolOverrides).length > 0) {
        ;(promptParams.body as any).tools = toolOverrides
      }

      let content = ""
      let reasoning = ""

      const buildResponsesFunctionCallOutputItem = (toolCall: any) => ({
        id: toolCall.id,
        type: "function_call",
        status: "completed",
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      })

      const buildResponsesMessageOutputItem = (text: string) => {
        if (!text) return null
        return {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text }],
        }
      }

      if (requestStream || stream) {
        const responseId = `resp_${crypto.randomUUID()}`
        const messageOutputIndex = 0
        const reasoningOutputIndex = 1
        const contentIndex = 0
        const outputItemId = `msg_${crypto.randomUUID()}`
        const reasoningItemId = "reasoning-0"
        let nextOutputIndex = 2
        let sequenceNumber = 0
        let announcedOutput = false
        let announcedContent = false
        let announcedReasoning = false
        const nextSeq = () => sequenceNumber++
        let sink: ((frame: string) => void) | null = null
        const emit = (payload: any) => sink?.(`data: ${JSON.stringify(payload)}\n\n`)

        emit({
          type: "response.created",
          sequence_number: nextSeq(),
          response: { id: responseId, object: "response", created: Math.floor(Date.now() / 1000), model: `${pID}/${mID}` },
        })

        const shouldStripStreamingToolMarkup = externalToolRegistry.length > 0
        const filterContentDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup })
        const filterReasoningDelta = createToolCallFilter({ disableTools: DISABLE_TOOLS, forceStrip: shouldStripStreamingToolMarkup })
        const parseContentToolCalls = createExternalToolCallStreamParser(externalToolRegistry)
        const parseReasoningToolCalls = createExternalToolCallStreamParser(externalToolRegistry)
        const streamedToolCalls: any[] = []
        let rawContent = ""
        let rawReasoning = ""

        const ensureOutputScaffold = () => {
          if (!announcedOutput) {
            emit({
              type: "response.output_item.added",
              sequence_number: nextSeq(),
              output_index: messageOutputIndex,
              item: { id: outputItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
            })
            announcedOutput = true
          }
          if (!announcedContent) {
            emit({
              type: "response.content_part.added",
              sequence_number: nextSeq(),
              output_index: messageOutputIndex,
              content_index: contentIndex,
              item_id: outputItemId,
              part: { type: "output_text", text: "" },
            })
            announcedContent = true
          }
        }
        const ensureReasoningScaffold = () => {
          if (!announcedReasoning) {
            emit({
              type: "response.output_item.added",
              sequence_number: nextSeq(),
              output_index: reasoningOutputIndex,
              item: { id: reasoningItemId, type: "reasoning", status: "in_progress", summary: [{ type: "summary_text", text: "" }] },
            })
            announcedReasoning = true
          }
        }
        const emitResponsesFunctionCall = (toolCall: any) => {
          const outputIndex = nextOutputIndex++
          const functionCallItem = buildResponsesFunctionCallOutputItem(toolCall)
          streamedToolCalls.push(toolCall)
          emit({
            type: "response.output_item.added",
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: { ...functionCallItem, status: "in_progress" },
          })
          emit({
            type: "response.function_call_arguments.delta",
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item_id: toolCall.id,
            delta: toolCall.function.arguments,
          })
          emit({
            type: "response.function_call_arguments.done",
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item_id: toolCall.id,
            arguments: toolCall.function.arguments,
          })
          emit({
            type: "response.output_item.done",
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: functionCallItem,
          })
        }
        const sendResponsesDelta = (delta: string, isReasoning = false) => {
          if (!delta) return
          if (isReasoning) rawReasoning += delta
          else rawContent += delta
          const parsedDeltaToolCalls = isReasoning ? parseReasoningToolCalls(delta) : parseContentToolCalls(delta)
          if (parsedDeltaToolCalls.length > 0) {
            const { validCalls: allowedDeltaToolCalls } = finalizeValidatedToolCalls(parsedDeltaToolCalls, externalToolRegistry)
            allowedDeltaToolCalls.forEach((toolCall: any) => emitResponsesFunctionCall(toolCall))
          }
          const filtered = isReasoning ? filterReasoningDelta(delta) : filterContentDelta(delta)
          if (!filtered) return
          if (isReasoning) {
            ensureReasoningScaffold()
            reasoning += filtered
            emit({
              type: "response.reasoning_summary_text.delta",
              sequence_number: nextSeq(),
              output_index: reasoningOutputIndex,
              item_id: reasoningItemId,
              summary_index: 0,
              delta: filtered,
            })
          } else {
            if (!filtered.trim()) {
              content += filtered
              return
            }
            ensureOutputScaffold()
            content += filtered
            emit({
              type: "response.output_text.delta",
              sequence_number: nextSeq(),
              output_index: messageOutputIndex,
              content_index: contentIndex,
              item_id: outputItemId,
              delta: filtered,
            })
          }
        }

        const responsesStreamBody = async () => {
          let collected: any = null
          try {
            const collectPromise = collectFromEvents(sessionId!, REQUEST_TIMEOUT_MS, sendResponsesDelta, EVENT_FIRST_DELTA_TIMEOUT_MS, EVENT_IDLE_TIMEOUT_MS)
            const safeCollect = collectPromise.catch((err) => ({ __error: err }))
            client.sessionPrompt(promptParams.path.id, promptParams.body).catch((err: any) => logDebug("Responses prompt error:", err.message))
            collected = await safeCollect
          } catch (e: any) {
            collected = { __error: e }
          }

          if (!content && !reasoning) {
            const polled = await pollForAssistantResponse(sessionId!, REQUEST_TIMEOUT_MS)
            if (polled.error && !polled.content && !polled.reasoning) throw polled.error
            if (polled.reasoning) sendResponsesDelta(polled.reasoning, true)
            if (polled.content) sendResponsesDelta(polled.content, false)
          } else if (collected && collected.idleTimeout) {
            const polled = await pollForAssistantResponse(sessionId!, REQUEST_TIMEOUT_MS)
            const remainingReasoning = polled.reasoning && polled.reasoning.startsWith(rawReasoning) ? polled.reasoning.slice(rawReasoning.length) : polled.reasoning
            const remainingContent = polled.content && polled.content.startsWith(rawContent) ? polled.content.slice(rawContent.length) : polled.content
            if (remainingReasoning) sendResponsesDelta(remainingReasoning, true)
            if (remainingContent) sendResponsesDelta(remainingContent, false)
          } else if (collected && (collected.content || collected.reasoning)) {
            if (!reasoning && collected.reasoning) sendResponsesDelta(collected.reasoning, true)
            if (!content && collected.content) sendResponsesDelta(collected.content, false)
          }

          if (announcedReasoning) {
            emit({
              type: "response.reasoning_summary_text.done",
              sequence_number: nextSeq(),
              output_index: reasoningOutputIndex,
              item_id: reasoningItemId,
              summary_index: 0,
              text: reasoning,
            })
            emit({
              type: "response.output_item.done",
              sequence_number: nextSeq(),
              output_index: reasoningOutputIndex,
              item: { id: reasoningItemId, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: reasoning }] },
            })
          }

          const hasMeaningfulContent = Boolean(content && content.trim())

          if (announcedContent && hasMeaningfulContent) {
            emit({
              type: "response.output_text.done",
              sequence_number: nextSeq(),
              output_index: messageOutputIndex,
              content_index: contentIndex,
              item_id: outputItemId,
              text: content,
            })
            emit({
              type: "response.content_part.done",
              sequence_number: nextSeq(),
              output_index: messageOutputIndex,
              content_index: contentIndex,
              item_id: outputItemId,
              part: { type: "output_text", text: content },
            })
            emit({
              type: "response.output_item.done",
              sequence_number: nextSeq(),
              output_index: messageOutputIndex,
              item: { id: outputItemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: content }] },
            })
          }

          let polledForToolCalls: any = null
          if (externalToolRegistry.length > 0 && streamedToolCalls.length === 0) {
            try {
              polledForToolCalls = await pollForAssistantResponse(sessionId!, REQUEST_TIMEOUT_MS)
            } catch {}
          }

          const flushedReasoningCalls = parseReasoningToolCalls.flush ? parseReasoningToolCalls.flush() : []
          const flushedContentCalls = parseContentToolCalls.flush ? parseContentToolCalls.flush() : []
          const flushedReasoningText = filterReasoningDelta.flush ? filterReasoningDelta.flush() : ""
          const flushedContentText = filterContentDelta.flush ? filterContentDelta.flush() : ""
          const finalReasoningText = (polledForToolCalls?.reasoning || rawReasoning) + flushedReasoningText
          const finalContentText = (polledForToolCalls?.content || rawContent) + flushedContentText

          const parseStreamedToolCalls = () => {
            if (externalToolRegistry.length === 0) return []
            const perChannel = [
              ...flushedReasoningCalls,
              ...flushedContentCalls,
              ...parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText, finalContentText),
            ]
            if (perChannel.length > 0) return perChannel
            return parseExternalToolCallsFromText(externalToolRegistry, finalReasoningText + finalContentText)
          }

          let parsedToolCalls = streamedToolCalls.length > 0 ? streamedToolCalls : parseStreamedToolCalls()
          if (parsedToolCalls.length === 0 && externalToolChoice.mode === "required") {
            const forcedResponse = await requestForcedResponsesToolCall()
            if (forcedResponse) {
              parsedToolCalls = parseExternalToolCallsFromText(externalToolRegistry, forcedResponse.reasoning, forcedResponse.content)
            }
          }
          const { validCalls: validatedStreamedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry)
          const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content))
          const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning))
          if (streamedToolCalls.length === 0) {
            validatedStreamedToolCalls.forEach((toolCall: any) => {
              emitResponsesFunctionCall(toolCall)
            })
          }
          const streamOutput: any[] = []
          const streamMessageOutputItem = buildResponsesMessageOutputItem(safeContent && safeContent.trim() ? safeContent : "")
          if (streamMessageOutputItem) streamOutput.push(streamMessageOutputItem)
          validatedStreamedToolCalls.forEach((toolCall: any) => {
            streamOutput.push(buildResponsesFunctionCallOutputItem(toolCall))
          })
          const promptTokens = Math.ceil(fullPromptText.length / 4)
          const completionTokens = Math.ceil(content.length / 4)
          const reasoningTokens = Math.ceil(reasoning.length / 4)
          const response = {
            id: responseId,
            object: "response",
            created: Math.floor(Date.now() / 1000),
            model: `${pID}/${mID}`,
            reasoning: safeReasoning ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) } : undefined,
            output: streamOutput,
            usage: {
              input_tokens: promptTokens,
              output_tokens: completionTokens + reasoningTokens,
              total_tokens: promptTokens + completionTokens + reasoningTokens,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: reasoningTokens },
            },
          }
          emit({ type: "response.completed", sequence_number: nextSeq(), response })
          sink?.("data: [DONE]\n\n")
          storeResponseState(responseId, sessionId!, `${pID}/${mID}`)
        }

        try {
          return sseResponse(async (emitOuter) => {
            sink = emitOuter
            try {
              await responsesStreamBody()
            } catch (error: any) {
              console.error("[Local] Responses API Error:", error?.message || error?.name || error)
              emit({ type: "response.failed", response: { error: transformUpstreamError(error).error } })
              sink?.("data: [DONE]\n\n")
            }
          })
        } catch (error: any) {
          return errorResponse(transformUpstreamError(error))
        }
      }

      const responseRes = await client.sessionPrompt(promptParams.path.id, promptParams.body)
      const responseParts = responseRes.data?.parts || []
      const promptContent = responseParts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n")
      const promptReasoning = responseParts
        .filter((p: any) => p.type === "reasoning")
        .map((p: any) => p.text)
        .join("\n")
      let promptBasedToolCalls =
        externalToolRegistry.length > 0 ? parseExternalToolCallsFromText(externalToolRegistry, promptReasoning, promptContent) : []

      content = promptBasedToolCalls.length > 0 ? "" : promptContent
      reasoning = promptReasoning

      const shouldPollForResponses = !promptContent && !promptReasoning
      if (shouldPollForResponses) {
        const polledResponse = await pollForAssistantResponse(sessionId!, REQUEST_TIMEOUT_MS)
        if (polledResponse.error && !polledResponse.content && !polledResponse.reasoning) {
          throw polledResponse.error
        }
        content = polledResponse.content || content
        reasoning = polledResponse.reasoning || reasoning
        promptBasedToolCalls =
          externalToolRegistry.length > 0 ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content) : []
      }

      if (!content && !reasoning && responseRes.data && promptBasedToolCalls.length === 0) {
        const data = responseRes.data
        content = typeof data === "string" ? data : data?.message || JSON.stringify(data)
      }

      let parsedToolCalls =
        promptBasedToolCalls.length > 0
          ? promptBasedToolCalls
          : externalToolRegistry.length > 0
            ? parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
            : []
      if (parsedToolCalls.length === 0 && externalToolChoice.mode === "required") {
        const forcedResponse = await requestForcedResponsesToolCall()
        if (forcedResponse) {
          content = forcedResponse.content || content
          reasoning = forcedResponse.reasoning || reasoning
          parsedToolCalls = parseExternalToolCallsFromText(externalToolRegistry, reasoning, content)
        }
      }
      const { validCalls: validatedToolCalls } = finalizeValidatedToolCalls(parsedToolCalls, externalToolRegistry)
      const safeContent = stripFunctionCallMarkup(stripFunctionCalls(content))
      const safeReasoning = stripFunctionCallMarkup(stripFunctionCalls(reasoning))

      const promptTokens = Math.ceil(fullPromptText.length / 4)
      const completionTokens = Math.ceil(content.length / 4)
      const reasoningTokens = Math.ceil(reasoning.length / 4)
      const output: any[] = []
      const messageOutputItem = buildResponsesMessageOutputItem(safeContent)
      if (messageOutputItem) output.push(messageOutputItem)
      validatedToolCalls.forEach((toolCall: any) => {
        output.push(buildResponsesFunctionCallOutputItem(toolCall))
      })

      const responseId = `resp_${crypto.randomUUID()}`
      const response = {
        id: responseId,
        object: "response",
        created: Math.floor(Date.now() / 1000),
        model: `${pID}/${mID}`,
        reasoning: safeReasoning ? { effort: reasoningLevel, summary: safeReasoning.substring(0, 100) } : undefined,
        output,
        usage: {
          input_tokens: promptTokens,
          output_tokens: completionTokens + reasoningTokens,
          total_tokens: promptTokens + completionTokens + reasoningTokens,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: reasoningTokens },
        },
      }

      storeResponseState(responseId, sessionId!, `${pID}/${mID}`)

      return jsonResponse(response)
    } catch (error: any) {
      console.error("[Local] Responses API Error:", error?.message || error?.data?.message || error?.name || error)
      return errorResponse(transformUpstreamError(error))
    }
  }

  return {
    id: config.id,
    async listModels() {
      try {
        const models = buildModelsList(await getProvidersList())
        return models.map((m) => m.id)
      } catch (error: any) {
        console.error("[Local] Model Fetch Error:", error.message)
        return ["opencode/kimi-k2.5-free"]
      }
    },
    handleChat,
    handleResponses,
    healthDetails() {
      return {
        status: "ok",
        proxy: true,
        upstream: config.id,
        backend: serverUrl,
        internal_tools: {
          config: {
            allowed_tools: SERVER_INTERNAL_ALLOWED_TOOL_NAMES,
            discovery_fixture: [],
          },
          metrics: { ...internalToolMetrics },
          cache: {
            tool_ids_cached: !!cachedToolIds,
            tool_id_count: cachedToolIds ? cachedToolIds.length : 0,
            age_ms: cachedToolIdsAt ? Date.now() - cachedToolIdsAt : null,
          },
        },
      }
    },
    metricsText() {
      const metricsLines = [
        "# HELP opencode_internal_tool_mode_requests_total Count of internal tool mode selections by mode.",
        "# TYPE opencode_internal_tool_mode_requests_total counter",
        `opencode_internal_tool_mode_requests_total{mode="external_bridge"} ${internalToolMetrics.externalBridgeRequests}`,
        `opencode_internal_tool_mode_requests_total{mode="internal_allowlist"} ${internalToolMetrics.internalAllowlistRequests}`,
        `opencode_internal_tool_mode_requests_total{mode="disabled"} ${internalToolMetrics.disabledRequests}`,
        `# HELP opencode_internal_tool_discovery_failures_total Count of backend tool discovery failures.`,
        `# TYPE opencode_internal_tool_discovery_failures_total counter`,
        `opencode_internal_tool_discovery_failures_total ${internalToolMetrics.discoveryFailures}`,
        `# HELP opencode_internal_tool_fallback_disabled_total Count of allowlist resolutions that fell back to disabled.`,
        `# TYPE opencode_internal_tool_fallback_disabled_total counter`,
        `opencode_internal_tool_fallback_disabled_total ${internalToolMetrics.fallbackToDisabled}`,
        `# HELP opencode_internal_tool_cache_ids Number of cached backend tool IDs.`,
        `# TYPE opencode_internal_tool_cache_ids gauge`,
        `opencode_internal_tool_cache_ids ${cachedToolIds ? cachedToolIds.length : 0}`,
      ]
      return `${metricsLines.join("\n")}\n`
    },
    async warmup() {
      await ensureBackendOnce()
    },
    killBackend() {
      killBackendFor(serverUrl)
    },
  }
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...CORS } })
}

/**
 * Push-based SSE response. The OpenCode event stream delivers deltas from async
 * callbacks, so the response body must be enqueued directly (Express res.write
 * semantics) instead of pulled from a generator.
 */
function sseResponse(run: (emit: (frame: string) => void) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (frame: string) => {
        try {
          controller.enqueue(encoder.encode(frame))
        } catch {}
      }
      run(emit)
        .catch((error) => {
          try {
            emit(`data: ${JSON.stringify({ error: { message: error?.message ?? "stream error" } })}\n\n`)
          } catch {}
        })
        .finally(() => {
          try {
            controller.close()
          } catch {}
        })
    },
  })
  return new Response(body, { status: 200, headers: { ...SSE_HEADERS, ...CORS } })
}
