import type {
  MaybeOpenAIClient,
  OpenAICreateMethod,
} from "./openai-client-shape.js"
import {
  buildOpenAIUsageEventFromFailure,
  buildOpenAIUsageEventFromSuccess,
} from "./build-openai-usage-event.js"
import { wrapOpenAIStreamResult } from "./wrap-openai-stream-result.js"
import { ensureActivityMetadata } from "../../metadata/ensure-activity-metadata.js"
import { mergeOrluneMetadata } from "../../metadata/merge-orlune-metadata.js"
import { stripWrappedRequestMetadata } from "../../metadata/strip-wrapped-request-metadata.js"
import type {
  UsageApiFamily,
} from "../../types.js"
import type { WrapProviderClientOptions } from "../provider-adapter.js"
import { checkGuardrails } from "../../internal/check-guardrails.js"
import { OrluneEvaluationException } from "../../guardrails.js"
import { extractOpenAIPrompt } from "./extract-prompt.js"
import { observeApiCall } from "../observe-api-call.js"
import { captureTelemetry } from "../../internal/capture-telemetry.js"
import type { WrappedOpenAIClient } from "./openai-client-types.js"

function warnTelemetryIssues(warnings: string[]) {
  for (const warning of warnings) {
    console.warn(`[orlune] ${warning}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as Record<PropertyKey, unknown>)[Symbol.asyncIterator] === "function"
}

function isStreamingInput(input: unknown): boolean {
  return isRecord(input) && input.stream === true
}

function prepareOpenAIInputForForwarding<TInput>(
  input: TInput,
  apiFamily: UsageApiFamily,
): TInput {
  if (!isRecord(input)) {
    return input
  }

  if (apiFamily !== "OPENAI_CHAT_COMPLETIONS" || input.stream !== true) {
    return input
  }

  const streamOptions = isRecord(input.stream_options)
    ? input.stream_options
    : {}

  return {
    ...input,
    stream_options: {
      ...streamOptions,
      include_usage: true,
    },
  } as TInput
}

function wrapCreateMethod(
  method: OpenAICreateMethod | undefined,
  apiFamily: UsageApiFamily,
  options: WrapProviderClientOptions,
): OpenAICreateMethod | undefined {
  if (typeof method !== "function") {
    return method
  }

  return function wrappedOpenAICreate(this: unknown, ...args: unknown[]) {
    const [firstArg, ...restArgs] = args
    const { cleanInput, orluneMetadata } = stripWrappedRequestMetadata(firstArg)
    const forwardedInput = prepareOpenAIInputForForwarding(cleanInput, apiFamily)
    const effectiveMetadata = ensureActivityMetadata(mergeOrluneMetadata(
      options.orluneOptions?.defaults,
      orluneMetadata,
    ))
    const isStreaming = isStreamingInput(cleanInput)

    let startedAt = new Date().toISOString()
    const eventBuilderParams = { apiFamily, metadata: effectiveMetadata, startedAt, input: forwardedInput }

    const onError = (error: unknown) => captureTelemetry(async () => {
      const usageEventResult = buildOpenAIUsageEventFromFailure(
        { ...eventBuilderParams, completedAt: new Date().toISOString() }, error,
      )
      warnTelemetryIssues(usageEventResult.warnings)
      if (usageEventResult.event) {
        await options.telemetryDispatcher.dispatch(usageEventResult.event)
      }
    })

    return observeApiCall({
      start: async () => {
        // Preflight is outside provider error handling: a denied call has no provider event.
        if (options.guardrails?.enabled) {
          if (!options.evaluate) throw new OrluneEvaluationException("Guardrail evaluator is not configured.", "INVALID_REQUEST")
          const requestOptions = restArgs[0]
          const signal = isRecord(requestOptions) && requestOptions.signal instanceof AbortSignal
            ? requestOptions.signal : undefined
          await checkGuardrails(options.evaluate, options.guardrails, effectiveMetadata, signal,
            extractOpenAIPrompt(cleanInput, apiFamily))
        }
        startedAt = new Date().toISOString()
        eventBuilderParams.startedAt = startedAt
        try {
          // Keep the provider promise inside an object to avoid assimilating it.
          return { value: method.apply(this, [forwardedInput, ...restArgs]) }
        } catch (error) {
          await onError(error)
          throw error
        }
      },
      onResult: async (result) => {
        if (isStreaming && isAsyncIterable(result)) {
          return wrapOpenAIStreamResult(
            result,
            {
              apiFamily,
              input: forwardedInput,
              metadata: effectiveMetadata,
              startedAt,
              telemetryDispatcher: options.telemetryDispatcher,
            },
          )
        }

        const completedAt = new Date().toISOString()
        await captureTelemetry(async () => {
          const usageEventResult = buildOpenAIUsageEventFromSuccess(
            {
              ...eventBuilderParams,
              completedAt,
            },
            result,
          )
          warnTelemetryIssues(usageEventResult.warnings)

          if (usageEventResult.event) {
            await options.telemetryDispatcher.dispatch(usageEventResult.event)
          }
        })

        return result
      },
      onError,
    })
  }
}

/**
 * Wraps the supported OpenAI create methods while leaving the rest of the client untouched.
 */
export function wrapOpenAIClient<TClient extends object>(
  client: TClient,
  options: WrapProviderClientOptions,
): WrappedOpenAIClient<TClient> {
  const openAIClient = client as TClient & MaybeOpenAIClient

  if (openAIClient.responses?.create) {
    const wrappedCreate = wrapCreateMethod(
      openAIClient.responses.create,
      "OPENAI_RESPONSES",
      options,
    )

    if (wrappedCreate) {
      openAIClient.responses.create = wrappedCreate
    }
  }

  if (openAIClient.chat?.completions?.create) {
    const wrappedCreate = wrapCreateMethod(
      openAIClient.chat.completions.create,
      "OPENAI_CHAT_COMPLETIONS",
      options,
    )

    if (wrappedCreate) {
      openAIClient.chat.completions.create = wrappedCreate
    }
  }

  return openAIClient as WrappedOpenAIClient<TClient>
}
