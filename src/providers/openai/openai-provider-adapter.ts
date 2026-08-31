import type { ProviderAdapter, WrapProviderClientOptions } from "../provider-adapter.js"
import { wrapOpenAIClient } from "./wrap-openai-client.js"

export const openAIProviderAdapter: ProviderAdapter = {
  wrap<TClient extends object>(client: TClient, options: WrapProviderClientOptions): TClient {
    return wrapOpenAIClient(client, options)
  },
}
