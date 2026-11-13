import type { WithMetadataAtPath } from "../wrapped-client-types.js"

export type AnthropicCompatibleClient = { messages: { create: (...args: never[]) => unknown } }

// Keep stream()'s native generic signature and schema inference. Its metadata
// is validated at runtime by the wrapped create() that the helper invokes.
export type WrappedAnthropicClient<T extends AnthropicCompatibleClient> =
  WithMetadataAtPath<T, "messages.create", "asResponse" | "withResponse">
