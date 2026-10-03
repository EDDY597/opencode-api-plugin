import { findExternalToolByName, type ExternalTool } from "./tools.ts"

/**
 * Tool-call markup parsing (ported from opencode2api src/tool-runtime/parser.js, MIT).
 *
 * The proxy asks models to emit tool calls as `<function_calls>{json}</function_calls>`.
 * Models served by OpenCode's free tier frequently ignore that contract and fall back to
 * whatever markup their own training used. Everything is normalized to the canonical
 * `<function_calls>` form at the parser boundary; downstream code is unchanged.
 *
 * Recognized foreign formats: DSML (DeepSeek), <tool_call> JSON wrappers, registry-named
 * tags with attributes/body/JSON, XML parameter children, <function=name> dialect, and
 * registry-gated bare JSON spanning the whole message body.
 */

// U+FF5C fullwidth vertical line, or an ASCII pipe, around an optional DSML tag.
const MARK = "[\\uFF5C|]*(?:DSML)?[\\uFF5C|]*"

const CANONICAL_OPEN = "<function_calls>"
const CANONICAL_CLOSE = "</function_calls>"

const RE = {
  canonicalBlock: /<function_calls>([\s\S]*?)<\/function_calls>/g,
  canonicalStrayTag: /<\/?function_calls>/g,
  dsmlContainer: new RegExp(`<${MARK}tool_calls\\s*>([\\s\\S]*?)</${MARK}tool_calls\\s*>`, "g"),
  invokeBlock: new RegExp(`<${MARK}invoke\\s+name\\s*=\\s*["']([^"']+)["']\\s*>([\\s\\S]*?)</${MARK}invoke\\s*>`, "g"),
  invokeParam: new RegExp(`<${MARK}parameter\\s+name\\s*=\\s*["']([^"']+)["']([^>]*)>([\\s\\S]*?)</${MARK}parameter\\s*>`, "g"),
  jsonWrapper: /<tool_call\s*>([\s\S]*?)<\/tool_call\s*>/g,
  codeFence: /^\s*```(?:[a-zA-Z0-9_-]*)\s*\n([\s\S]*?)\n?\s*```\s*$/,
  leadingNewline: /^\r?\n/,
  trailingNewline: /\r?\n[ \t]*$/,
}

const escapeRegExp = (value: string) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export type RawToolCall = { id?: string; name: string; arguments: unknown }
type ExtractResult = { calls: RawToolCall[]; spans: [number, number][] }

function registryNames(registry: ExternalTool[]): string[] {
  if (!Array.isArray(registry)) return []
  const names = new Set<string>()
  registry.forEach((tool) => {
    if (tool?.namespacedName) names.add(tool.namespacedName)
    if (tool?.originalName) names.add(tool.originalName)
  })
  return [...names].sort((a, b) => b.length - a.length)
}

function registrySchemas(registry: ExternalTool[]): Map<string, any> {
  const schemas = new Map<string, any>()
  if (!Array.isArray(registry)) return schemas
  registry.forEach((tool) => {
    if (!tool?.parameters) return
    if (tool.namespacedName) schemas.set(tool.namespacedName, tool.parameters)
    if (tool.originalName) schemas.set(tool.originalName, tool.parameters)
  })
  return schemas
}

function trimParamValue(raw: unknown) {
  return String(raw ?? "")
    .replace(RE.leadingNewline, "")
    .replace(RE.trailingNewline, "")
}

function coerceParamValue(value: string, attrs: string | null) {
  if (/string\s*=\s*["']true["']/i.test(attrs || "")) return value
  const trimmed = value.trim()
  if (!trimmed) return value
  if (!/^(-?\d|true$|false$|null$|\{|\[|")/.test(trimmed)) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function rawCallFromJson(node: any): RawToolCall | null {
  if (!node || typeof node !== "object") return null
  const name = node?.function?.name || node?.name || node?.tool_name || node?.tool
  if (!name || typeof name !== "string") return null
  let args = node?.function?.arguments ?? node?.arguments ?? node?.parameters ?? node?.args ?? {}
  if (typeof args === "string") {
    const trimmed = args.trim()
    if (!trimmed) {
      args = {}
    } else {
      try {
        args = JSON.parse(trimmed)
      } catch {
        return { id: node?.id, name, arguments: trimmed }
      }
    }
  }
  return { id: node?.id, name, arguments: args }
}

function rawCallsFromJsonPayload(parsed: any): RawToolCall[] {
  const candidates = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.tool_calls)
      ? parsed.tool_calls
      : Array.isArray(parsed?.invokes)
        ? parsed.invokes
        : [parsed]
  return candidates.map(rawCallFromJson).filter(Boolean) as RawToolCall[]
}

function rawCallsFromJsonText(text: string): RawToolCall[] {
  const trimmed = String(text ?? "").trim()
  if (!trimmed) return []
  try {
    return rawCallsFromJsonPayload(JSON.parse(trimmed))
  } catch {
    const found = findFirstJsonValue(trimmed)
    if (!found) return []
    try {
      return rawCallsFromJsonPayload(JSON.parse(found.json))
    } catch {
      return []
    }
  }
}

function findJsonEnd(text: string, start: number): number {
  const opener = text[start]
  if (opener !== "{" && opener !== "[") return -1
  const closer = opener === "{" ? "}" : "]"
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === opener) depth += 1
    else if (ch === closer) {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

function findFirstJsonValue(text: string): { json: string; start: number; end: number } | null {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{" && text[i] !== "[") continue
    const end = findJsonEnd(text, i)
    if (end === -1) continue
    const json = text.slice(i, end)
    try {
      JSON.parse(json)
      return { json, start: i, end }
    } catch {
      // Keep scanning; this brace was not the start of a valid value.
    }
  }
  return null
}

// --- format extractors -------------------------------------------------------

function extractCanonical(text: string): ExtractResult {
  const calls: RawToolCall[] = []
  const spans: [number, number][] = []
  for (const match of text.matchAll(RE.canonicalBlock)) {
    spans.push([match.index, match.index + match[0].length])
    calls.push(...rawCallsFromJsonText(match[1]))
  }
  return { calls, spans }
}

function extractInvokeBlocks(segment: string): RawToolCall[] {
  const calls: RawToolCall[] = []
  for (const invoke of segment.matchAll(RE.invokeBlock)) {
    const args: Record<string, unknown> = {}
    for (const param of invoke[2].matchAll(RE.invokeParam)) {
      args[param[1]] = coerceParamValue(trimParamValue(param[3]), param[2])
    }
    calls.push({ name: invoke[1], arguments: args })
  }
  return calls
}

function extractDsml(text: string): ExtractResult {
  const calls: RawToolCall[] = []
  const spans: [number, number][] = []
  let remainder = text

  for (const container of text.matchAll(RE.dsmlContainer)) {
    spans.push([container.index, container.index + container[0].length])
    const inner = extractInvokeBlocks(container[1])
    calls.push(...(inner.length ? inner : rawCallsFromJsonText(container[1])))
    remainder = remainder.replace(container[0], " ".repeat(container[0].length))
  }

  for (const invoke of remainder.matchAll(RE.invokeBlock)) {
    spans.push([invoke.index, invoke.index + invoke[0].length])
    calls.push(...extractInvokeBlocks(invoke[0]))
  }

  return { calls, spans }
}

function extractJsonWrapper(text: string): ExtractResult {
  const calls: RawToolCall[] = []
  const spans: [number, number][] = []
  for (const match of text.matchAll(RE.jsonWrapper)) {
    spans.push([match.index, match.index + match[0].length])
    calls.push(...rawCallsFromJsonText(match[1]))
  }
  return { calls, spans }
}

function argsFromAttrs(attrs: string): string | null {
  const marker = attrs.match(/(?:arguments|parameters|args|input)\s*=\s*/i)
  if (!marker || marker.index === undefined) return null
  const start = marker.index + marker[0].length
  const opener = attrs[start]

  if (opener === '"' || opener === "'") {
    let i = start + 1
    let out = ""
    while (i < attrs.length && attrs[i] !== opener) {
      if (attrs[i] === "\\" && i + 1 < attrs.length) {
        out += attrs[i + 1]
        i += 2
        continue
      }
      out += attrs[i]
      i += 1
    }
    return out
  }

  if (opener === "{" || opener === "[") {
    const end = findJsonEnd(attrs, start)
    if (end !== -1) return attrs.slice(start, end)
  }
  return null
}

function coerceSchemaValue(value: string, schema: any) {
  const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type
  if (type === "string") return value
  const trimmed = value.trim()
  if (!trimmed) return value
  if (type === "number" || type === "integer") {
    const num = Number(trimmed)
    return Number.isFinite(num) ? num : value
  }
  if (type === "boolean") {
    if (/^true$/i.test(trimmed)) return true
    if (/^false$/i.test(trimmed)) return false
    return value
  }
  if (type === "object" || type === "array") {
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }
  return coerceParamValue(value, "")
}

function argsFromXmlChildren(body: string, parameters: any): Record<string, unknown> | null {
  const properties = parameters && typeof parameters === "object" ? parameters.properties : null
  if (!properties || typeof properties !== "object") return null
  const allowed = Object.keys(properties)
  if (!allowed.length) return null

  const args: Record<string, unknown> = {}
  let matched = 0
  for (const key of allowed) {
    const re = new RegExp(`<${escapeRegExp(key)}\\s*>([\\s\\S]*?)</${escapeRegExp(key)}\\s*>`, "i")
    const found = body.match(re)
    if (!found) continue
    matched += 1
    args[key] = coerceSchemaValue(trimParamValue(found[1]), properties[key])
  }
  return matched > 0 ? args : null
}

function findTagEnd(text: string, from: number): number {
  let i = from
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      i += 1
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i += 1
        i += 1
      }
      i += 1
      continue
    }
    if (ch === "{" || ch === "[") {
      const end = findJsonEnd(text, i)
      if (end !== -1) {
        i = end
        continue
      }
    }
    if (ch === ">") return i
    i += 1
  }
  return -1
}

function extractTagNamed(text: string, names: string[], schemas: Map<string, any>): ExtractResult {
  const calls: RawToolCall[] = []
  const spans: [number, number][] = []
  if (!names.length) return { calls, spans }

  const opener = new RegExp(`<(${names.map(escapeRegExp).join("|")})(?=[\\s/>"'])`, "g")

  for (const match of text.matchAll(opener)) {
    const name = match[1]
    const attrsStart = match.index + match[0].length
    const tagEnd = findTagEnd(text, attrsStart)
    if (tagEnd === -1) continue
    const attrs = text.slice(attrsStart, tagEnd)
    const openEnd = tagEnd + 1

    const attrArgs = argsFromAttrs(attrs)
    if (attrArgs !== null) {
      const parsed = rawCallsFromJsonText(attrArgs)
      if (parsed.length) {
        calls.push(...parsed.map((call) => ({ ...call, name: call.name || name })))
      } else {
        try {
          calls.push({ name, arguments: JSON.parse(attrArgs) })
        } catch {
          calls.push({ name, arguments: {} })
        }
      }
      spans.push([match.index, openEnd])
      continue
    }

    if (attrs.trim().endsWith("/")) {
      calls.push({ name, arguments: {} })
      spans.push([match.index, openEnd])
      continue
    }

    const closeTag = `</${name}>`
    const closeIdx = text.indexOf(closeTag, openEnd)
    const body = closeIdx === -1 ? text.slice(openEnd) : text.slice(openEnd, closeIdx)
    const json = findFirstJsonValue(body)
    const consumedEnd = closeIdx === -1 ? (json ? openEnd + json.end : openEnd) : closeIdx + closeTag.length

    if (json) {
      const parsed = rawCallsFromJsonText(json.json)
      const named = parsed.filter((call) => call.name)
      if (named.length) {
        calls.push(...named)
      } else {
        try {
          calls.push({ name, arguments: JSON.parse(json.json) })
        } catch {
          calls.push({ name, arguments: {} })
        }
      }
    } else {
      const xmlArgs = argsFromXmlChildren(body, schemas.get(name))
      calls.push({ name, arguments: xmlArgs || {} })
    }
    spans.push([match.index, consumedEnd])
  }

  return { calls, spans }
}

function extractBareJson(text: string, names: string[]): ExtractResult {
  if (!names.length) return { calls: [], spans: [] }
  const trimmed = text.trim()
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[" && !trimmed.startsWith("```"))) {
    return { calls: [], spans: [] }
  }

  const fenced = trimmed.match(RE.codeFence)
  const body = (fenced ? fenced[1] : trimmed).trim()
  if (!body || (body[0] !== "{" && body[0] !== "[")) return { calls: [], spans: [] }

  const calls = rawCallsFromJsonText(body).filter((call) => names.includes(call.name))
  if (!calls.length) return { calls: [], spans: [] }
  return { calls, spans: [[0, text.length]] }
}

function extractFunctionEquals(text: string): ExtractResult {
  const calls: RawToolCall[] = []
  const spans: [number, number][] = []
  const openerRe = /<function\s*=\s*([^\s/>]+)\s*>/gi
  for (const match of text.matchAll(openerRe)) {
    const name = match[1].trim()
    if (!name) continue
    const openEnd = match.index + match[0].length
    const closeIdx = text.indexOf("</function>", openEnd)
    const end = closeIdx === -1 ? text.length : closeIdx + "</function>".length
    const body = closeIdx === -1 ? text.slice(openEnd) : text.slice(openEnd, closeIdx)

    const args: Record<string, unknown> = {}
    const paramRe = /<parameter\s*=\s*([^\s/>]+)\s*>([\s\S]*?)<\/parameter\s*>/gi
    for (const param of body.matchAll(paramRe)) {
      args[param[1].trim()] = trimParamValue(param[2])
    }

    calls.push({ name, arguments: args })
    spans.push([match.index, end])
  }
  return { calls, spans }
}

function collectAll(text: string, registry: ExternalTool[]): ExtractResult {
  const source = typeof text === "string" ? text : ""
  if (!source) return { calls: [], spans: [] }
  const names = registryNames(registry)
  const schemas = registrySchemas(registry)

  const results = [
    extractCanonical(source),
    extractDsml(source),
    extractJsonWrapper(source),
    extractFunctionEquals(source),
    extractTagNamed(source, names, schemas),
    extractBareJson(source, names),
  ]

  const seen = new Set<string>()
  const calls: RawToolCall[] = []
  results.forEach((result) => {
    result.calls.forEach((call) => {
      const key = `${call.name}::${JSON.stringify(call.arguments)}`
      if (seen.has(key)) return
      seen.add(key)
      calls.push(call)
    })
  })

  return { calls, spans: results.flatMap((result) => result.spans) }
}

// --- public API --------------------------------------------------------------

export function stripFunctionCallMarkup(text: string, trim = true, options: { registry?: ExternalTool[] | null } = {}) {
  if (!text) return text
  const { spans } = collectAll(text, options.registry ?? [])

  let cleaned = text
  if (spans.length) {
    const merged = [...spans]
      .sort((a, b) => a[0] - b[0])
      .reduce<[number, number][]>((acc, span) => {
        const last = acc[acc.length - 1]
        if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
        else acc.push([...span])
        return acc
      }, [])
    cleaned = merged.reduceRight((acc, [start, end]) => acc.slice(0, start) + acc.slice(end), cleaned)
  }

  cleaned = cleaned.replace(RE.canonicalStrayTag, "")
  return trim ? cleaned.trim() : cleaned
}

export function parseExternalToolCallsFromText(registry: ExternalTool[] | null, ...chunks: string[]) {
  if (!Array.isArray(registry) || registry.length === 0) return []
  const rawCalls: RawToolCall[] = []
  chunks.forEach((chunk) => {
    if (!chunk || typeof chunk !== "string") return
    rawCalls.push(...collectAll(chunk, registry).calls)
  })

  const counts = new Map<string, number>()
  return rawCalls.flatMap((rawCall) => {
    const tool = findExternalToolByName(registry, rawCall.name)
    if (!tool) return []
    const nextCount = (counts.get(tool.namespacedName) || 0) + 1
    counts.set(tool.namespacedName, nextCount)
    return [
      {
        id: rawCall.id || `call_${tool.namespacedName.replace(/[^a-zA-Z0-9_]/g, "_")}_${nextCount}`,
        type: "function",
        function: {
          name: tool.originalName,
          arguments: typeof rawCall.arguments === "string" ? rawCall.arguments : JSON.stringify(rawCall.arguments ?? {}),
        },
      },
    ]
  })
}

function markerOpeners(registry: ExternalTool[]) {
  const openers = ["<function_calls", "<function=", "<tool_call", "<tool_calls", "<invoke", "<parameter", "<\uFF5C", "<|"]
  registryNames(registry).forEach((name) => openers.push(`<${name.toLowerCase()}`))
  return openers
}

function couldBeMarker(candidate: string, openers: string[]) {
  const lower = candidate.toLowerCase()
  return openers.some((opener) => opener.startsWith(lower) || lower.startsWith(opener))
}

const INLINE_BLOCKS = [
  { open: new RegExp(`^<${MARK}tool_calls\\s*>`, "i"), close: new RegExp(`</${MARK}tool_calls\\s*>`, "i") },
  { open: new RegExp(`^<${MARK}invoke\\s`, "i"), close: new RegExp(`</${MARK}invoke\\s*>`, "i") },
  { open: /^<tool_call\s*>/i, close: /<\/tool_call\s*>/i },
  { open: new RegExp(`^${escapeRegExp(CANONICAL_OPEN)}`, "i"), close: new RegExp(escapeRegExp(CANONICAL_CLOSE), "i") },
]

const KNOWN_CLOSE_TAG = new RegExp(
  `^</${MARK}(?:function_calls|function|tool_calls|tool_call|invoke|parameter)\\s*>`,
  "i",
)

const PARTIAL_CLOSE_TAG = /^<\/[a-z0-9_\uFF5C|]*$/i

function matchInlineBlock(buffer: string): { pending?: boolean; end?: number } | null {
  for (const block of INLINE_BLOCKS) {
    if (!block.open.test(buffer)) continue
    const close = buffer.match(block.close)
    if (!close || close.index === undefined) return { pending: true }
    return { end: close.index + close[0].length }
  }
  return null
}

export type StreamTextFilter = ((chunk: string) => string) & { flush: () => string }

export function createToolCallFilter(options: {
  disableTools: boolean
  forceStrip?: boolean
  registry?: ExternalTool[] | null
}): StreamTextFilter {
  const { disableTools, forceStrip = false, registry = null } = options
  if (!disableTools && !forceStrip) {
    const passthrough = (chunk: string) => chunk
    passthrough.flush = () => ""
    return passthrough
  }

  const openers = markerOpeners(registry ?? [])
  let buffer = ""
  let emittedVisible = false
  let held = false

  const filter = (chunk: string) => {
    if (!chunk) return ""
    buffer += chunk
    let output = ""

    while (buffer.length) {
      if (held) return output

      const inline = matchInlineBlock(buffer)
      if (inline?.pending) return output
      if (inline?.end !== undefined) {
        buffer = buffer.slice(inline.end)
        continue
      }

      const orphanClose = buffer.match(KNOWN_CLOSE_TAG)
      if (orphanClose) {
        buffer = buffer.slice(orphanClose[0].length)
        continue
      }
      if (PARTIAL_CLOSE_TAG.test(buffer)) return output

      if (!emittedVisible && !output.trim() && /^\s*[{[]/.test(buffer)) {
        held = true
        return output
      }

      const markerIdx = buffer.indexOf("<")
      if (markerIdx === -1) {
        output += buffer
        buffer = ""
        break
      }

      if (markerIdx > 0) {
        output += buffer.slice(0, markerIdx)
        buffer = buffer.slice(markerIdx)
        continue
      }

      if (!couldBeMarker(buffer, openers)) {
        output += buffer[0]
        buffer = buffer.slice(1)
        continue
      }

      const complete = /^<[^\s/>]+[^>]*>/.test(buffer)
      if (!complete) return output
      held = true
      return output
    }

    if (output.trim()) emittedVisible = true
    return output
  }

  filter.flush = () => {
    const remaining = buffer
    buffer = ""
    held = false
    if (!remaining) return ""
    const stripped = stripFunctionCallMarkup(remaining, false, { registry })
    return KNOWN_CLOSE_TAG.test(stripped.trim()) ? "" : stripped
  }

  return filter
}

export type StreamToolCallParser = ((chunk: string) => any[]) & { flush: () => any[] }

export function createExternalToolCallStreamParser(registry: ExternalTool[] | null): StreamToolCallParser {
  if (!Array.isArray(registry) || registry.length === 0) {
    const noop = () => [] as any[]
    noop.flush = () => []
    return noop
  }

  const openers = markerOpeners(registry)
  let buffer = ""
  let sequence = 0

  const withUniqueIds = (calls: any[]) =>
    calls.map((call) => {
      sequence += 1
      return { ...call, id: `${call.id}_${sequence}` }
    })

  const parser = (chunk: string) => {
    if (!chunk) return []
    buffer += chunk
    const calls: any[] = []

    while (buffer.length) {
      const markerIdx = buffer.search(/<[^\s]/)
      if (markerIdx === -1) break

      const candidate = buffer.slice(markerIdx)
      const inline = matchInlineBlock(candidate)
      if (inline?.pending) break
      if (inline?.end !== undefined) {
        const block = candidate.slice(0, inline.end)
        calls.push(...withUniqueIds(parseExternalToolCallsFromText(registry, block)))
        buffer = candidate.slice(inline.end)
        continue
      }

      if (couldBeMarker(candidate, openers)) break
      buffer = candidate.slice(1)
    }

    return calls
  }

  parser.flush = () => {
    const remaining = buffer
    buffer = ""
    if (!remaining.trim()) return []
    return withUniqueIds(parseExternalToolCallsFromText(registry, remaining))
  }

  return parser
}
