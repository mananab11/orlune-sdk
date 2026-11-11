export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

export type AnthropicMethod = (this: unknown, ...args: unknown[]) => unknown
export type AnthropicClientShape = {
  baseURL?: string
  messages?: { create?: AnthropicMethod; stream?: AnthropicMethod }
}
