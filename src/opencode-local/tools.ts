/**
 * External tool bridging (ported from opencode2api src/tool-runtime/*.js, MIT).
 *
 * Client-declared tools are virtualized: they never reach OpenCode as native tools.
 * The registry namespaces them, the router produces the markup contract injected into
 * the prompt, the parser reads model replies back into tool calls, and the validator
 * + policy gate what is surfaced to the client.
 */

export const EXTERNAL_TOOL_PREFIX = "external__"

export const TOOL_RISK_LEVELS = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
} as const

export const TOOL_SIDE_EFFECTS = {
  NONE: "none",
  READ: "read",
  WRITE: "write",
  DELETE: "delete",
  EXTERNAL_NOTIFICATION: "external_notification",
  PAYMENT: "payment",
} as const

export const TOOL_POLICY_DECISIONS = {
  ALLOW: "allow",
  DENY: "deny",
  REQUIRE_CONFIRMATION: "require_confirmation",
} as const

export const VALIDATION_STATUSES = {
  VALID: "valid",
  REPAIRABLE: "repairable",
  REJECTED: "rejected",
} as const

export type RiskLevel = (typeof TOOL_RISK_LEVELS)[keyof typeof TOOL_RISK_LEVELS]
export type SideEffect = (typeof TOOL_SIDE_EFFECTS)[keyof typeof TOOL_SIDE_EFFECTS]

function normalizeRiskLevel(value: unknown, fallback: RiskLevel = TOOL_RISK_LEVELS.LOW): RiskLevel {
  if (!value || typeof value !== "string") return fallback
  const normalized = value.trim().toLowerCase()
  return (Object.values(TOOL_RISK_LEVELS) as string[]).includes(normalized) ? (normalized as RiskLevel) : fallback
}

function normalizeSideEffect(value: unknown, fallback: SideEffect = TOOL_SIDE_EFFECTS.NONE): SideEffect {
  if (!value || typeof value !== "string") return fallback
  const normalized = value.trim().toLowerCase()
  return (Object.values(TOOL_SIDE_EFFECTS) as string[]).includes(normalized) ? (normalized as SideEffect) : fallback
}

function createValidationError(code: string, message: string, path: string[] = []) {
  return { code, message, path }
}

// --- registry ----------------------------------------------------------------

export type ExternalTool = {
  id: string
  originalName: string
  namespacedName: string
  description: string
  parameters: any
  sideEffect: SideEffect
  riskLevel: RiskLevel
  requiresConfirmation: boolean
  enabled: boolean
  sourceTool: any
}

function normalizeDescription(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeParameters(parameters: unknown) {
  if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) return parameters
  return { type: "object", properties: {} }
}

/**
 * Normalizes the two function-tool shapes the proxy receives.
 * Chat Completions nests the definition:  { type:'function', function:{ name, parameters } }
 * The Responses API keeps it flat:        { type:'function', name, parameters }
 */
function normalizeToolDefinition(tool: any) {
  if (!tool || tool.type !== "function") return null
  const definition = tool.function && typeof tool.function === "object" ? tool.function : tool
  const name = String(definition.name || "").trim()
  if (!name) return null
  return {
    name,
    description: definition.description,
    parameters: definition.parameters,
    enabled: definition.enabled,
    x_proxy_side_effect: definition.x_proxy_side_effect ?? tool.x_proxy_side_effect,
    x_proxy_risk_level: definition.x_proxy_risk_level ?? tool.x_proxy_risk_level,
    x_proxy_requires_confirmation: definition.x_proxy_requires_confirmation ?? tool.x_proxy_requires_confirmation,
  }
}

function inferSideEffect(definition: any = {}): SideEffect {
  const declared = definition.x_proxy_side_effect
  if (declared) return normalizeSideEffect(declared, TOOL_SIDE_EFFECTS.NONE)

  const name = String(definition.name || "").toLowerCase()
  if (/^(get|list|search|find|read|fetch|lookup)/.test(name)) return TOOL_SIDE_EFFECTS.READ
  if (/^(create|update|set|post|write|send)/.test(name)) return TOOL_SIDE_EFFECTS.WRITE
  if (/^(delete|remove|destroy)/.test(name)) return TOOL_SIDE_EFFECTS.DELETE
  return TOOL_SIDE_EFFECTS.NONE
}

function inferRiskLevel(definition: any = {}, sideEffect: SideEffect = TOOL_SIDE_EFFECTS.NONE): RiskLevel {
  const declared = definition.x_proxy_risk_level
  if (declared) return normalizeRiskLevel(declared, TOOL_RISK_LEVELS.LOW)
  if (sideEffect === TOOL_SIDE_EFFECTS.DELETE || sideEffect === TOOL_SIDE_EFFECTS.PAYMENT) {
    return TOOL_RISK_LEVELS.CRITICAL
  }
  if (sideEffect === TOOL_SIDE_EFFECTS.WRITE || sideEffect === TOOL_SIDE_EFFECTS.EXTERNAL_NOTIFICATION) {
    return TOOL_RISK_LEVELS.MEDIUM
  }
  return TOOL_RISK_LEVELS.LOW
}

function inferRequiresConfirmation(
  definition: any = {},
  sideEffect: SideEffect = TOOL_SIDE_EFFECTS.NONE,
  riskLevel: RiskLevel = TOOL_RISK_LEVELS.LOW,
) {
  if (typeof definition.x_proxy_requires_confirmation === "boolean") return definition.x_proxy_requires_confirmation
  return (
    sideEffect === TOOL_SIDE_EFFECTS.WRITE || riskLevel === TOOL_RISK_LEVELS.HIGH || riskLevel === TOOL_RISK_LEVELS.CRITICAL
  )
}

export function buildExternalToolRegistry(tools: unknown, options: { prefix?: string } = {}): ExternalTool[] {
  if (!Array.isArray(tools) || tools.length === 0) return []
  const prefix = options.prefix || EXTERNAL_TOOL_PREFIX
  const registry: ExternalTool[] = []
  const seenNamespaced = new Set<string>()

  tools.forEach((tool: any, index: number) => {
    const definition = normalizeToolDefinition(tool)
    if (!definition) return
    const originalName = definition.name

    let namespacedName = `${prefix}${originalName}`
    let counter = 2
    while (seenNamespaced.has(namespacedName)) {
      namespacedName = `${prefix}${originalName}_${counter}`
      counter += 1
    }
    seenNamespaced.add(namespacedName)

    const sideEffect = inferSideEffect(definition)
    const riskLevel = inferRiskLevel(definition, sideEffect)
    registry.push({
      id: `external_tool_${index + 1}`,
      originalName,
      namespacedName,
      description: normalizeDescription(definition.description),
      parameters: normalizeParameters(definition.parameters),
      sideEffect,
      riskLevel,
      requiresConfirmation: inferRequiresConfirmation(definition, sideEffect, riskLevel),
      enabled: definition.enabled !== false,
      sourceTool: tool,
    })
  })

  return registry
}

function normalizeToolNameForMatch(name: unknown) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

export function findExternalToolByName(registry: ExternalTool[] | null, name: unknown): ExternalTool | null {
  if (!name || !Array.isArray(registry)) return null
  const exact = registry.find((tool) => tool.namespacedName === name || tool.originalName === name)
  if (exact) return exact

  // Models frequently drop separators or change case when emitting a tool name.
  // Fall back to a separator/case-insensitive match, but only when it is
  // unambiguous — an exact match always wins and a tie resolves to nothing.
  const normalized = normalizeToolNameForMatch(name)
  if (!normalized) return null
  const matches = registry.filter(
    (tool) => normalizeToolNameForMatch(tool.namespacedName) === normalized || normalizeToolNameForMatch(tool.originalName) === normalized,
  )
  return matches.length === 1 ? matches[0] : null
}

// --- router ------------------------------------------------------------------

export function normalizeExternalToolChoice(toolChoice: any, registry: ExternalTool[]) {
  if (!toolChoice || !Array.isArray(registry) || registry.length === 0) {
    return { mode: "auto", requiredTool: null }
  }
  if (toolChoice === "auto" || toolChoice === "none") {
    return { mode: toolChoice, requiredTool: null }
  }
  if (toolChoice === "required") {
    return { mode: "required", requiredTool: null }
  }
  const requestedName = toolChoice?.function?.name || toolChoice?.name
  if (toolChoice?.type === "function" && requestedName) {
    const mappedTool = findExternalToolByName(registry, requestedName)
    return {
      mode: "required",
      requiredTool: mappedTool?.namespacedName || `${EXTERNAL_TOOL_PREFIX}${requestedName}`,
    }
  }
  return { mode: "auto", requiredTool: null }
}

export function buildExternalToolsPrompt(registry: ExternalTool[], toolChoice: any = null) {
  if (!Array.isArray(registry) || registry.length === 0) return ""
  const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry)
  const choiceInstructions: string[] = []
  if (normalizedChoice.mode === "required") {
    if (normalizedChoice.requiredTool) {
      choiceInstructions.push(
        `Tool use is REQUIRED for this turn. You MUST call ${normalizedChoice.requiredTool} before giving any final answer.`,
      )
    } else {
      choiceInstructions.push("Tool use is REQUIRED for this turn. You MUST call an external tool before giving any final answer.")
    }
  } else if (normalizedChoice.mode === "none") {
    choiceInstructions.push("Tool use is disabled for this turn. Do not emit <function_calls>.")
  }

  return [
    "External tools are virtualized by this proxy. They are not OpenCode tools.",
    "When you need an external tool, your entire assistant reply MUST be ONLY one or more <function_calls>...</function_calls> blocks.",
    "Do NOT output <think>, explanations, markdown, prose, or any text before or after <function_calls> blocks when making a tool call.",
    "Each block must contain JSON with this exact shape:",
    '{"name":"external__tool_name","arguments":{}}',
    "Arguments must be a valid JSON object that matches the declared schema.",
    "Use only the namespaced names listed below. Do not use original client tool names inside function calls.",
    "If tool results are later provided as TOOL_RESULT messages, use those results to continue normally.",
    ...choiceInstructions,
    `Available external tools: ${JSON.stringify(
      registry.map((tool) => ({
        name: tool.namespacedName,
        client_name: tool.originalName,
        description: tool.description,
        parameters: tool.parameters,
        risk_level: tool.riskLevel,
        side_effect: tool.sideEffect,
        requires_confirmation: tool.requiresConfirmation,
      })),
    )}`,
  ].join("\n")
}

/**
 * Short imperative restatement of the markup contract, appended as the final prompt
 * part. Position matters more than wording: with the contract only in the system
 * prompt, deepseek-v4-flash-free emitted parseable markup in 4/8 runs; with this
 * reminder as the last thing before generation it was 8/8.
 */
export function buildExternalToolsReminder(registry: ExternalTool[], toolChoice: any = null) {
  if (!Array.isArray(registry) || registry.length === 0) return ""
  const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry)
  if (normalizedChoice.mode === "none") return ""
  const exampleName = normalizedChoice.requiredTool || registry[0].namespacedName
  return [
    "REMINDER: External tools are called by emitting markup, not through any native tool API.",
    `To call one, your entire reply must be ONLY <function_calls>{"name":"${exampleName}","arguments":{...}}</function_calls>`,
    "with no prose, no markdown and no <think> block. Otherwise answer normally.",
    `Available names: ${registry.map((tool) => tool.namespacedName).join(", ")}`,
  ].join("\n")
}

export function buildToolExposure(registry: ExternalTool[], toolChoice: any = null) {
  const normalizedChoice = normalizeExternalToolChoice(toolChoice, registry)
  const exposedTools = Array.isArray(registry) ? registry.filter((tool) => tool.enabled !== false) : []
  return {
    tools: exposedTools,
    toolChoice: normalizedChoice,
    prompt: buildExternalToolsPrompt(exposedTools, toolChoice),
    reminder: buildExternalToolsReminder(exposedTools, toolChoice),
  }
}

// --- policy ------------------------------------------------------------------

function toSet(values: unknown) {
  if (!Array.isArray(values)) return new Set<string>()
  return new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => (value as string).trim()))
}

type PolicyContext = {
  mode: string
  defaultRiskLevel: RiskLevel
  allowlist: Set<string>
  denylist: Set<string>
  confirmationRequired: Set<string>
}

function createPolicyContext(config: any = {}): PolicyContext {
  return {
    mode: config.EXTERNAL_TOOL_POLICY_MODE || "enforce",
    defaultRiskLevel: (config.EXTERNAL_TOOL_DEFAULT_RISK_LEVEL || TOOL_RISK_LEVELS.LOW) as RiskLevel,
    allowlist: toSet(config.EXTERNAL_TOOL_ALLOWLIST || []),
    denylist: toSet(config.EXTERNAL_TOOL_DENYLIST || []),
    confirmationRequired: toSet(config.EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR || []),
  }
}

export function evaluateToolPolicy(tool: ExternalTool | null, args: unknown, context: { config?: any } = {}) {
  if (!tool) {
    return {
      status: TOOL_POLICY_DECISIONS.DENY,
      code: "unknown_tool",
      reason: "Tool is not registered for this request.",
    }
  }

  const policy = createPolicyContext(context.config)
  const toolNames = [tool.originalName, tool.namespacedName].filter(Boolean)
  const inAllowlist = toolNames.some((name) => policy.allowlist.has(name))
  const inDenylist = toolNames.some((name) => policy.denylist.has(name))
  const requiresConfirmation = tool.requiresConfirmation || toolNames.some((name) => policy.confirmationRequired.has(name))

  if (inAllowlist) {
    return { status: TOOL_POLICY_DECISIONS.ALLOW, effectiveRisk: tool.riskLevel || policy.defaultRiskLevel }
  }

  if (inDenylist) {
    return {
      status: TOOL_POLICY_DECISIONS.DENY,
      code: "tool_denied_by_policy",
      reason: `Tool ${tool.originalName} is denied by policy.`,
    }
  }

  if (!inAllowlist && (tool.sideEffect === TOOL_SIDE_EFFECTS.DELETE || tool.riskLevel === TOOL_RISK_LEVELS.CRITICAL)) {
    return {
      status: TOOL_POLICY_DECISIONS.REQUIRE_CONFIRMATION,
      reason: `Tool ${tool.originalName} is high risk and requires confirmation.`,
      confirmationPayload: {
        toolName: tool.originalName,
        namespacedName: tool.namespacedName,
        argumentsPreview: args,
        risk: tool.riskLevel,
      },
    }
  }

  if (requiresConfirmation && policy.mode !== "report-only") {
    return {
      status: TOOL_POLICY_DECISIONS.REQUIRE_CONFIRMATION,
      reason: `Tool ${tool.originalName} requires confirmation before execution.`,
      confirmationPayload: {
        toolName: tool.originalName,
        namespacedName: tool.namespacedName,
        argumentsPreview: args,
        risk: tool.riskLevel,
      },
    }
  }

  return { status: TOOL_POLICY_DECISIONS.ALLOW, effectiveRisk: tool.riskLevel || policy.defaultRiskLevel }
}

// --- validator ---------------------------------------------------------------

function safeParseJsonObject(raw: unknown): { ok: boolean; value?: any; error?: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: {} }
  }
  if (typeof raw === "object") {
    return Array.isArray(raw) ? { ok: false, error: "arguments must be a JSON object" } : { ok: true, value: raw }
  }
  if (typeof raw !== "string") {
    return { ok: false, error: "arguments must be a JSON string or object" }
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "arguments must decode to a JSON object" }
    }
    return { ok: true, value: parsed }
  } catch (error: any) {
    return { ok: false, error: error.message }
  }
}

function validateAgainstSchema(args: Record<string, unknown>, schema: any = {}) {
  const errors: ReturnType<typeof createValidationError>[] = []
  const normalizedSchema = schema && typeof schema === "object" ? schema : {}
  const properties = normalizedSchema.properties && typeof normalizedSchema.properties === "object" ? normalizedSchema.properties : {}
  const required = Array.isArray(normalizedSchema.required) ? normalizedSchema.required : []

  required.forEach((key: string) => {
    if (!(key in args) || args[key] === undefined || args[key] === null || args[key] === "") {
      errors.push(createValidationError("missing_required_field", `Missing required field: ${key}`, [key]))
    }
  })

  Object.entries(properties).forEach(([key, definition]: [string, any]) => {
    if (!(key in args) || args[key] === undefined || args[key] === null) return
    const value = args[key]
    const expectedType = definition?.type
    if (expectedType === "string" && typeof value !== "string") {
      errors.push(createValidationError("invalid_type", `Field ${key} must be a string`, [key]))
    }
    if (expectedType === "number" && typeof value !== "number") {
      errors.push(createValidationError("invalid_type", `Field ${key} must be a number`, [key]))
    }
    if (expectedType === "integer" && !Number.isInteger(value)) {
      errors.push(createValidationError("invalid_type", `Field ${key} must be an integer`, [key]))
    }
    if (expectedType === "boolean" && typeof value !== "boolean") {
      errors.push(createValidationError("invalid_type", `Field ${key} must be a boolean`, [key]))
    }
    if (expectedType === "object" && (!value || typeof value !== "object" || Array.isArray(value))) {
      errors.push(createValidationError("invalid_type", `Field ${key} must be an object`, [key]))
    }
    if (Array.isArray(definition?.enum) && !definition.enum.includes(value)) {
      errors.push(createValidationError("invalid_enum", `Field ${key} must be one of: ${definition.enum.join(", ")}`, [key]))
    }
  })

  return errors
}

export function validateToolCall(parsedCall: any, registry: ExternalTool[]) {
  const tool = findExternalToolByName(registry, parsedCall?.function?.name)
  if (!tool) {
    return {
      status: VALIDATION_STATUSES.REJECTED,
      errors: [createValidationError("unknown_tool", `Unknown external tool: ${parsedCall?.function?.name || "unknown"}`)],
      tool: null,
    }
  }

  const parsedArgs = safeParseJsonObject(parsedCall?.function?.arguments)
  if (!parsedArgs.ok) {
    return {
      status: VALIDATION_STATUSES.REPAIRABLE,
      errors: [createValidationError("invalid_arguments_json", `Invalid JSON arguments for ${tool.originalName}: ${parsedArgs.error}`)],
      tool,
    }
  }

  const schemaErrors = validateAgainstSchema(parsedArgs.value, tool.parameters)
  if (schemaErrors.length > 0) {
    return { status: VALIDATION_STATUSES.REJECTED, errors: schemaErrors, tool }
  }

  return { status: VALIDATION_STATUSES.VALID, normalizedArguments: parsedArgs.value, tool }
}

export function validateToolCalls(parsedCalls: unknown, registry: ExternalTool[]) {
  if (!Array.isArray(parsedCalls) || parsedCalls.length === 0) {
    return { validCalls: [] as any[], invalidCalls: [] as any[] }
  }

  const validCalls: any[] = []
  const invalidCalls: any[] = []
  parsedCalls.forEach((call: any) => {
    const validation = validateToolCall(call, registry)
    if (validation.status === VALIDATION_STATUSES.VALID) {
      validCalls.push({
        ...call,
        validatedArguments: validation.normalizedArguments,
        function: {
          ...call.function,
          arguments: JSON.stringify(validation.normalizedArguments),
        },
        tool: validation.tool,
        validation,
      })
      return
    }
    invalidCalls.push({ call, validation })
  })

  return { validCalls, invalidCalls }
}
