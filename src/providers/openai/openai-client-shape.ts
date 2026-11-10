export type OpenAICreateMethod = (...args: unknown[]) => unknown

export type MaybeOpenAIClient = {
  baseURL?: string
  responses?: {
    create?: OpenAICreateMethod
  }
  chat?: {
    completions?: {
      create?: OpenAICreateMethod
    }
  }
}
