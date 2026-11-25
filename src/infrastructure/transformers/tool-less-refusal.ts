/**
 * Some Kiro models refuse every request whose current message carries no tool
 * schema: HTTP 200 with `stopReason: CONTENT_FILTERED`, no content. An empty
 * `tools: []` is not enough. Measured on claude-haiku-5.5; claude-haiku-4.5,
 * claude-sonnet-4.5 and claude-opus-5.5 answer tool-less requests normally.
 *
 * Small helper requests (title generation, image description, plain JSON tasks)
 * never declare tools, so we ride one inert tool along. Calls to it are dropped
 * before the client sees them.
 */
const TOOL_LESS_REFUSING_MODELS = new Set(['claude-haiku-5.5'])

/** Inert tool injected for a tool-less request; calls to it never reach the client. */
export const KIRO_PLACEHOLDER_TOOL_NAME = 'kiro_noop'

/** `kiroModel` is the resolved (Kiro-facing) model id, e.g. `claude-haiku-5.5`. */
export function requiresToolSpecification(kiroModel: string): boolean {
  return TOOL_LESS_REFUSING_MODELS.has(kiroModel)
}

/**
 * CodeWhisperer-shaped placeholder specification. The description states the
 * contract explicitly because the model is the only thing that could call it.
 */
export function buildPlaceholderToolSpec(): {
  toolSpecification: {
    name: string
    description: string
    inputSchema: { json: Record<string, unknown> }
  }
} {
  return {
    toolSpecification: {
      name: KIRO_PLACEHOLDER_TOOL_NAME,
      description: 'Placeholder. Never call this tool; answer the user directly.',
      inputSchema: { json: { type: 'object', properties: {} } }
    }
  }
}

/**
 * True only for a call to the placeholder a request actually injected. The
 * caller passes `placeholderToolName` only when it injected one, so a client
 * that declares its own tool with the same name keeps its calls.
 */
export function isPlaceholderToolCall(
  name: string | undefined,
  placeholderToolName?: string
): boolean {
  return !!placeholderToolName && name === placeholderToolName
}
