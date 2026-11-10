import type { WithMetadataAtPath } from "../wrapped-client-types.js"

export type OpenAICompatibleClient =
  | { responses: { create: (...args: never[]) => unknown } }
  | { chat: { completions: { create: (...args: never[]) => unknown } } }

export type WrappedOpenAIClient<T> = WithMetadataAtPath<
  T, "responses.create" | "chat.completions.create", "asResponse" | "withResponse"
>
