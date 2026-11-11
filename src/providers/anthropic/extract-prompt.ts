import { record } from "./anthropic-shapes.js"

/** Only current user text, never system instructions, tool results, or thinking blocks. */
export function extractAnthropicPrompt(input: unknown): string | undefined {
  const messages = record(input).messages
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = record(messages[index])
    if (message.role !== "user") continue
    if (typeof message.content === "string") return message.content
    if (!Array.isArray(message.content)) return undefined
    const parts = message.content.map(record)
      .filter(part => part.type === "text" && typeof part.text === "string")
    return parts.length ? parts.map(part => part.text).join("\n") : undefined
  }
  return undefined
}
