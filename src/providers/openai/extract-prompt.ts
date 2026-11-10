import type { UsageApiFamily } from "../../types.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Analyze only the latest user message, not trusted instructions or prior turns. */
export function extractOpenAIPrompt(input: unknown, apiFamily: UsageApiFamily): string | undefined {
  if (!isRecord(input)) return undefined
  const messages = apiFamily === "OPENAI_RESPONSES" ? input.input : input.messages
  if (apiFamily === "OPENAI_RESPONSES" && typeof messages === "string") return messages
  if (!Array.isArray(messages)) return undefined

  for (let index = messages.length - 1; index >= 0; index--) {
    const message: unknown = messages[index]
    if (!isRecord(message) || message.role !== "user") continue
    if (typeof message.content === "string") return message.content
    if (!Array.isArray(message.content)) return undefined
    const textType = apiFamily === "OPENAI_RESPONSES" ? "input_text" : "text"
    const parts = message.content.filter((part: unknown) =>
      isRecord(part) && part.type === textType && typeof part.text === "string",
    ) as Array<{ text: string }>
    // Do not fall back to an older user turn when the current turn has no text.
    return parts.length ? parts.map((part) => part.text).join("\n") : undefined
  }
  return undefined
}
