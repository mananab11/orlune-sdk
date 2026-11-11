import { record } from "./anthropic-shapes.js"
import { anthropicFailureStatus } from "./build-anthropic-usage-event.js"
import type { UsageEventStatus } from "../../internal/usage-event.js"

type Emit = (result: unknown, status: UsageEventStatus, error?: unknown) => Promise<void>

/** Observe the native iterator, leaving tee(), cancellation, and readable streams native. */
export function observeAnthropicStream(stream: AsyncIterable<unknown>, emit: Emit) {
  const original = stream[Symbol.asyncIterator].bind(stream)
  let message: Record<string, unknown> = {}
  let usage: Record<string, unknown> = {}
  let complete = false
  let hasOutputUpdate = false
  let pendingReads = 0
  const controller = record(stream).controller as AbortController | undefined
  // The native iterator also aborts during error cleanup; let an in-flight read report its real error.
  const onAbort = () => { if (!complete && pendingReads === 0) void settle({ ...message, usage: {} }, "CANCELED", { code: "STREAM_CANCELED" }) }
  const settle: Emit = (result, status, error) => {
    controller?.signal.removeEventListener("abort", onAbort)
    return emit(result, status, error)
  }
  controller?.signal.addEventListener("abort", onAbort, { once: true })
  if (controller?.signal.aborted) onAbort()

  const incomplete = () => settle({ ...message, usage: {} }, controller?.signal.aborted ? "CANCELED" : "FAILED",
    { code: controller?.signal.aborted ? "STREAM_CANCELED" : "STREAM_INCOMPLETE" })

  stream[Symbol.asyncIterator] = function (): AsyncIterableIterator<unknown> {
    const iterator = original()
    return {
      async next() {
        pendingReads++
        try {
          const item = await iterator.next()
          if (item.done) {
            if (!complete) await incomplete()
            return item
          }
          const event = record(item.value)
          if (event.type === "message_start") {
            const initial = record(event.message)
            message = { id: initial.id, model: initial.model }
            usage = structuredClone(record(initial.usage))
          } else if (event.type === "message_delta") {
            const delta = record(event.delta)
            if (delta.stop_reason != null) message.stop_reason = delta.stop_reason
            // Counts are cumulative; null/omitted fields do not erase earlier values.
            const update = record(event.usage)
            for (const [key, value] of Object.entries(update)) {
              if (value != null) usage[key] = structuredClone(value)
            }
            if (typeof update.output_tokens === "number") hasOutputUpdate = true
            if (delta.stop_reason != null && hasOutputUpdate) {
              complete = true
              await settle({ ...message, usage }, "SUCCEEDED")
            }
          } else if (event.type === "message_stop") {
            complete = true
            // Commit before yielding the terminal event, even if the consumer stops here.
            await settle({ ...message, usage: hasOutputUpdate ? usage : {} }, "SUCCEEDED")
          }
          return item
        } catch (error) {
          if (!complete) await settle({ ...message, usage: {} }, anthropicFailureStatus(error), error)
          throw error
        } finally {
          pendingReads--
        }
      },
      async return(value?: unknown) {
        try {
          return iterator.return ? await iterator.return(value) : { done: true, value }
        } finally {
          if (!complete) await settle({ ...message, usage: {} }, "CANCELED", { code: "STREAM_CANCELED" })
        }
      },
      async throw(error?: unknown) {
        try {
          if (iterator.throw) return await iterator.throw(error)
          throw error
        } finally {
          if (!complete) await settle({ ...message, usage: {} }, anthropicFailureStatus(error), error)
        }
      },
      [Symbol.asyncIterator]() { return this },
    }
  }
  return stream
}
