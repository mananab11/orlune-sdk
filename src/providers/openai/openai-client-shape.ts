export type OpenAICreateMethod = (...args: unknown[]) => unknown

export type MaybeOpenAIClient = {
  responses?: {
    create?: OpenAICreateMethod
  }
  chat?: {
    completions?: {
      create?: OpenAICreateMethod
    }
  }
}
