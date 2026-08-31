export type SupportedProvider = "OPENAI"

import type { MaybeOpenAIClient } from "./openai/openai-client-shape.js"

function hasFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function"
}

export function detectSupportedProvider(client: object): SupportedProvider | null {
  const maybeOpenAI = client as MaybeOpenAIClient

  if (
    hasFunction(maybeOpenAI.responses?.create) ||
    hasFunction(maybeOpenAI.chat?.completions?.create)
  ) {
    return "OPENAI"
  }

  return null
}
