import { detectSupportedProvider, type SupportedProvider } from "./detect-client.js"
import type { ProviderAdapter } from "./provider-adapter.js"
import { openAIProviderAdapter } from "./openai/openai-provider-adapter.js"

const providerAdapters: Record<SupportedProvider, ProviderAdapter> = {
  OPENAI: openAIProviderAdapter,
}

export function getProviderAdapter(client: object): ProviderAdapter | null {
  const provider = detectSupportedProvider(client)

  if (provider === null) {
    return null
  }

  return providerAdapters[provider]
}
