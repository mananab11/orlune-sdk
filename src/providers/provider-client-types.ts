import type { OpenAICompatibleClient, WrappedOpenAIClient } from "./openai/openai-client-types.js"
import type { AnthropicCompatibleClient, WrappedAnthropicClient } from "./anthropic/anthropic-client-types.js"

// Keep type dispatch aligned with runtime adapters. Method paths and return
// contracts belong to each adapter, not this registry.
export type WrappedProviderClient<T> = T extends OpenAICompatibleClient ? WrappedOpenAIClient<T>
  : T extends AnthropicCompatibleClient ? WrappedAnthropicClient<T> : T
