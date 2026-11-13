import { checkGuardrails } from "../../internal/check-guardrails.js"
import { OrluneEvaluationException } from "../../guardrails.js"
import { ensureActivityMetadata } from "../../metadata/ensure-activity-metadata.js"
import { mergeOrluneMetadata } from "../../metadata/merge-orlune-metadata.js"
import { stripWrappedRequestMetadata } from "../../metadata/strip-wrapped-request-metadata.js"
import { observeApiCall } from "../observe-api-call.js"
import type { WrapProviderClientOptions } from "../provider-adapter.js"
import type { UsageEventStatus } from "../../internal/usage-event.js"
import { record, type AnthropicClientShape } from "./anthropic-shapes.js"
import { buildAnthropicUsageEvent, anthropicFailureStatus } from "./build-anthropic-usage-event.js"
import { extractAnthropicPrompt } from "./extract-prompt.js"
import { observeAnthropicStream } from "./observe-anthropic-stream.js"
import { preserveGuardrailErrors } from "./preserve-guardrail-errors.js"
import { captureTelemetry, reportTelemetryError } from "../../internal/capture-telemetry.js"

export function wrapAnthropicClient(client: object, options: WrapProviderClientOptions): object {
  const messages = (client as AnthropicClientShape).messages!
  const create = messages.create!
  messages.create = function (...args: unknown[]) {
    const { cleanInput, orluneMetadata } = stripWrappedRequestMetadata(args[0])
    const metadata = ensureActivityMetadata(mergeOrluneMetadata(options.orluneOptions?.defaults, orluneMetadata))
    const streaming = record(cleanInput).stream === true
    let startedAt = new Date().toISOString()
    let emitted = false
    const emit = async (result: unknown, status: UsageEventStatus, error?: unknown) => {
      if (emitted) return
      emitted = true
      try {
        const event = buildAnthropicUsageEvent({ input: cleanInput, metadata, startedAt,
          captureType: streaming ? "STREAM_FINAL" : "RESPONSE" }, result, status, error)
        if (event) await options.telemetryDispatcher.dispatch(event)
      } catch {
        reportTelemetryError("[orlune] Anthropic telemetry capture failed.")
      }
    }
    return observeApiCall({
      start: async () => {
        const signal = record(args[1]).signal
        // A denied preflight is not a failed provider request and emits no provider telemetry.
        if (options.orluneOptions?.guardrails?.enabled) {
          if (!options.evaluate) throw new OrluneEvaluationException("Guardrail evaluator is not configured.", "INVALID_REQUEST")
          await checkGuardrails(options.evaluate, options.orluneOptions.guardrails, metadata,
            signal instanceof AbortSignal ? signal : undefined, extractAnthropicPrompt(cleanInput))
        }
        startedAt = new Date().toISOString()
        try { return { value: create.apply(this, [cleanInput, ...args.slice(1)]) } }
        catch (error) {
          await captureTelemetry(() => emit(undefined, anthropicFailureStatus(error), error))
          throw error
        }
      },
      onResult: async result => {
        if (streaming && result !== null && typeof result === "object" &&
            typeof Reflect.get(result, Symbol.asyncIterator) === "function") {
          return observeAnthropicStream(result as AsyncIterable<unknown>, emit)
        }
        await emit(result, "SUCCEEDED")
        return result
      },
      onError: error => emit(undefined, anthropicFailureStatus(error), error),
    })
  }
  const stream = messages.stream
  if (stream && options.orluneOptions?.guardrails?.enabled) {
    // Native stream() calls the wrapped create(); do not evaluate or emit a second time.
    messages.stream = function (...args: unknown[]) {
      const result = stream.apply(this, args)
      return result !== null && typeof result === "object" ? preserveGuardrailErrors(result) : result
    }
  }
  return client
}
