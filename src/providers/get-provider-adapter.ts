import { openAIProviderAdapter } from "./openai/openai-provider-adapter.js"
import type { ProviderAdapter } from "./provider-adapter.js"

const providerAdapters = [openAIProviderAdapter] as const
export type SupportedProvider = (typeof providerAdapters)[number]["provider"]

export function getProviderAdapter(client: object): (ProviderAdapter & { provider: SupportedProvider }) | null {
  return providerAdapters.find(adapter => adapter.matches(client)) ?? null
}
