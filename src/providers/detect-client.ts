import { getProviderAdapter, type SupportedProvider } from "./get-provider-adapter.js"
export type { SupportedProvider } from "./get-provider-adapter.js"

export function detectSupportedProvider(client: object): SupportedProvider | null {
  return getProviderAdapter(client)?.provider ?? null
}
