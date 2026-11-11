import type { ProviderAdapter } from "../provider-adapter.js"
import type { AnthropicClientShape } from "./anthropic-shapes.js"
import { wrapAnthropicClient } from "./wrap-anthropic-client.js"

export const anthropicProviderAdapter = {
  provider: "ANTHROPIC" as const,
  matches(client: object) {
    const candidate = client as AnthropicClientShape
    if (typeof candidate.baseURL !== "string" || typeof candidate.messages?.create !== "function") return false
    try {
      const url = new URL(candidate.baseURL)
      return url.protocol === "https:" && url.hostname === "api.anthropic.com"
    } catch { return false }
  },
  wrap: wrapAnthropicClient,
} satisfies ProviderAdapter
