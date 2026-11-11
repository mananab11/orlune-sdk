import type { MetadataMethod, WithMetadataAtPath } from "../wrapped-client-types.js"

export type AnthropicCompatibleClient = { messages: { create: (...args: never[]) => unknown } }

export type WrappedAnthropicClient<T extends AnthropicCompatibleClient> =
  WithMetadataAtPath<T, "messages.create", "asResponse" | "withResponse"> & {
    messages: {
      // Keep the native generic stream overload for structured-output inference.
      [K in keyof T["messages"] as K extends "stream" ? K : never]:
        T["messages"][K] & MetadataMethod<T["messages"][K]>
    }
  }
