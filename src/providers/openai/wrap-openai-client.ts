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
import type {
  UsageApiFamily,
  WrappedClientRequestMetadata,
} from "../../types.js"
import type { WrapProviderClientOptions } from "../provider-adapter.js"

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

function buildStreamWrapperParams(params: {
  apiFamily: UsageApiFamily
  input: unknown
  metadata: WrappedClientRequestMetadata["orlune_metadata"] | undefined
  startedAt: string
  telemetryDispatcher: WrapProviderClientOptions["telemetryDispatcher"]
}) {
  return params.metadata === undefined
    ? {
        apiFamily: params.apiFamily,
        input: params.input,
        startedAt: params.startedAt,
        telemetryDispatcher: params.telemetryDispatcher,
      }
    : {
        apiFamily: params.apiFamily,
        input: params.input,
        metadata: params.metadata,
        startedAt: params.startedAt,
        telemetryDispatcher: params.telemetryDispatcher,
      }
}

/**
 * Extract SDK-only metadata before forwarding the payload to the real provider SDK.
 */
export function stripWrappedRequestMetadata<TInput>(
  input: TInput,
): {
  cleanInput: TInput
  orluneMetadata: WrappedClientRequestMetadata["orlune_metadata"] | undefined
} {
  if (!isRecord(input) || !("orlune_metadata" in input)) {
    return {
      cleanInput: input,
      orluneMetadata: undefined,
    }
  }

  const { orlune_metadata, ...rest } = input

  return {
    cleanInput: rest as TInput,
    orluneMetadata:
      orlune_metadata && typeof orlune_metadata === "object"
        ? (orlune_metadata as WrappedClientRequestMetadata["orlune_metadata"])
        : undefined,
  }
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
    if (args.length === 0) {
      return method.apply(this, args)
    }

    const [firstArg, ...restArgs] = args
    const { cleanInput, orluneMetadata } = stripWrappedRequestMetadata(firstArg)
    const forwardedInput = prepareOpenAIInputForForwarding(cleanInput, apiFamily)
    const effectiveMetadata = ensureActivityMetadata(mergeOrluneMetadata(
      options.orluneOptions?.defaults,
      orluneMetadata,
    ))
    const isStreaming = isStreamingInput(cleanInput)

    const startedAt = new Date().toISOString()
    const eventBuilderParams =
      effectiveMetadata === undefined
        ? {
            apiFamily,
            startedAt,
            input: forwardedInput,
          }
        : {
            apiFamily,
            metadata: effectiveMetadata,
            startedAt,
            input: forwardedInput,
          }

    return Promise.resolve(method.apply(this, [forwardedInput, ...restArgs]))
      .then(async (result) => {
        if (isStreaming && isAsyncIterable(result)) {
          return wrapOpenAIStreamResult(
            result,
            buildStreamWrapperParams({
              apiFamily,
              input: forwardedInput,
              metadata: effectiveMetadata,
              startedAt,
              telemetryDispatcher: options.telemetryDispatcher,
            }),
          )
        }

        const completedAt = new Date().toISOString()
        const usageEventResult = buildOpenAIUsageEventFromSuccess(
          {
            ...eventBuilderParams,
            completedAt,
          },
          result,
        )
        warnTelemetryIssues(usageEventResult.warnings)

        if (usageEventResult.event) {
          try {
            await options.telemetryDispatcher.dispatch(usageEventResult.event)
          } catch {
            // Telemetry failures must not change provider call behavior.
          }
        }

        return result
      })
      .catch(async (error) => {
        const completedAt = new Date().toISOString()
        const usageEventResult = buildOpenAIUsageEventFromFailure(
          {
            ...eventBuilderParams,
            completedAt,
          },
          error,
        )
        warnTelemetryIssues(usageEventResult.warnings)

        if (usageEventResult.event) {
          try {
            await options.telemetryDispatcher.dispatch(usageEventResult.event)
          } catch {
            // Telemetry failures must not change provider call behavior.
          }
        }

        throw error
      })
  }
}

/**
 * Wraps the supported OpenAI create methods while leaving the rest of the client untouched.
 */
export function wrapOpenAIClient<TClient extends object>(
  client: TClient,
  options: WrapProviderClientOptions,
): TClient {
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

  return openAIClient
}
