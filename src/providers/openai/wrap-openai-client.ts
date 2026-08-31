import type {
  MaybeOpenAIClient,
  OpenAICreateMethod,
} from "./openai-client-shape.js"
import {
  buildOpenAIUsageEventFromFailure,
  buildOpenAIUsageEventFromSuccess,
} from "./build-openai-usage-event.js"
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
    const effectiveMetadata = ensureActivityMetadata(mergeOrluneMetadata(
      options.orluneOptions?.defaults,
      orluneMetadata,
    ))

    const startedAt = new Date().toISOString()
    const eventBuilderParams =
      effectiveMetadata === undefined
        ? {
            apiFamily,
            startedAt,
            input: cleanInput,
          }
        : {
            apiFamily,
            metadata: effectiveMetadata,
            startedAt,
            input: cleanInput,
          }

    return Promise.resolve(method.apply(this, [cleanInput, ...restArgs]))
      .then(async (result) => {
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
