import type { ProviderAdapter, WrapProviderClientOptions } from "../provider-adapter.js"
import { wrapOpenAIClient } from "./wrap-openai-client.js"
import type { WrappedOpenAIClient } from "./openai-client-types.js"
import type { MaybeOpenAIClient } from "./openai-client-shape.js"

export const openAIProviderAdapter = {
  provider: "OPENAI" as const,
  matches(client: object): boolean {
    const candidate = client as MaybeOpenAIClient
    // Compatible method names alone do not identify the billing provider.
    if (typeof candidate.baseURL !== "string") return false
    try {
      const url = new URL(candidate.baseURL)
      if (url.protocol !== "https:" || !(url.hostname === "api.openai.com" || url.hostname.endsWith(".api.openai.com"))) return false
    } catch {
      return false
    }
    return typeof candidate.responses?.create === "function" ||
      typeof candidate.chat?.completions?.create === "function"
  },
  wrap<TClient extends object>(client: TClient, options: WrapProviderClientOptions): WrappedOpenAIClient<TClient> {
    return wrapOpenAIClient(client, options)
  },
} satisfies ProviderAdapter
