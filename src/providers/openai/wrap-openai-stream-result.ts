import {
  buildOpenAIUsageEventFromFailure,
  buildOpenAIUsageEventFromStreamSuccess,
} from "./build-openai-usage-event.js"
import type { TelemetryDispatcher } from "../../internal/telemetry-dispatcher.js"
import type { UsageApiFamily } from "../../internal/usage-event.js"
import type { OrluneCallMetadata } from "../../types.js"

type OpenAIStreamWrapperParams = {
  apiFamily: UsageApiFamily
  input: unknown
  metadata?: OrluneCallMetadata
  startedAt: string
  telemetryDispatcher: TelemetryDispatcher
}

type ResponsesCompletedEvent = {
  type?: unknown
  response?: unknown
}

type ChatCompletionChoiceLike = {
  finish_reason?: unknown
}

type ChatCompletionChunkLike = {
  id?: unknown
  model?: unknown
  usage?: unknown
  choices?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function warnTelemetryIssues(warnings: string[]) {
  for (const warning of warnings) {
    console.warn(`[orlune] ${warning}`)
  }
}

function buildEventBuilderParams(params: {
  apiFamily: UsageApiFamily
  completedAt: string
  input: unknown
  metadata: OrluneCallMetadata | undefined
  startedAt: string
}) {
  return params.metadata === undefined
    ? {
        apiFamily: params.apiFamily,
        completedAt: params.completedAt,
        input: params.input,
        startedAt: params.startedAt,
      }
    : {
        apiFamily: params.apiFamily,
        completedAt: params.completedAt,
        input: params.input,
        metadata: params.metadata,
        startedAt: params.startedAt,
      }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as Record<PropertyKey, unknown>)[Symbol.asyncIterator] === "function"
}

function isTerminalResponsesCompletedEvent(event: unknown): event is ResponsesCompletedEvent {
  return isRecord(event) && event.type === "response.completed" && isRecord(event.response)
}

function createChatCompletionStreamSnapshot(state: {
  requestId?: string
  model?: string
  usage?: Record<string, unknown>
  finishReason?: string
}): Record<string, unknown> | null {
  if (!state.requestId && !state.model && !state.usage && !state.finishReason) {
    return null
  }

  return {
    ...(state.requestId ? { id: state.requestId } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.usage ? { usage: state.usage } : { usage: {} }),
    ...(state.finishReason
      ? {
          choices: [
            {
              finish_reason: state.finishReason,
            },
          ],
        }
      : {}),
  }
}

function observeChatCompletionChunk(
  chunk: unknown,
  state: {
    requestId?: string
    model?: string
    usage?: Record<string, unknown>
    finishReason?: string
  },
) {
  if (!isRecord(chunk)) {
    return
  }

  const requestId = getString((chunk as ChatCompletionChunkLike).id)

  if (requestId) {
    state.requestId = requestId
  }

  const model = getString((chunk as ChatCompletionChunkLike).model)

  if (model) {
    state.model = model
  }

  const usage = (chunk as ChatCompletionChunkLike).usage

  if (isRecord(usage)) {
    state.usage = usage
  }

  const rawChoices = (chunk as ChatCompletionChunkLike).choices
  const choices: unknown[] = Array.isArray(rawChoices)
    ? rawChoices
    : []
  const firstChoice = choices[0]

  if (!isRecord(firstChoice)) {
    return
  }

  const finishReason = getString((firstChoice as ChatCompletionChoiceLike).finish_reason)

  if (finishReason) {
    state.finishReason = finishReason
  }
}

function createCanceledStreamError(): Error {
  const error = new Error("OpenAI stream was canceled before completion.")
  error.name = "AbortError"
  return error
}

export function wrapOpenAIStreamResult<TResult extends object>(
  result: TResult,
  params: OpenAIStreamWrapperParams,
): TResult {
  if (!isAsyncIterable(result)) {
    return result
  }

  let telemetrySettled = false
  const chatCompletionState: {
    requestId?: string
    model?: string
    usage?: Record<string, unknown>
    finishReason?: string
  } = {}
  let finalResponsesResponse: Record<string, unknown> | null = null

  async function dispatchSuccess() {
    if (telemetrySettled) {
      return
    }

    const completedAt = new Date().toISOString()
    const successSource =
      params.apiFamily === "OPENAI_RESPONSES"
        ? finalResponsesResponse
        : createChatCompletionStreamSnapshot(chatCompletionState)

    if (!successSource) {
      await dispatchFailure(new Error("OpenAI stream ended without a final response payload."))
      return
    }

    telemetrySettled = true

    const usageEventResult = buildOpenAIUsageEventFromStreamSuccess(
      buildEventBuilderParams({
        apiFamily: params.apiFamily,
        completedAt,
        input: params.input,
        metadata: params.metadata,
        startedAt: params.startedAt,
      }),
      successSource,
    )
    warnTelemetryIssues(usageEventResult.warnings)

    if (usageEventResult.event) {
      try {
        await params.telemetryDispatcher.dispatch(usageEventResult.event)
      } catch {
        // Telemetry failures must not change provider call behavior.
      }
    }
  }

  async function dispatchFailure(error: unknown) {
    if (telemetrySettled) {
      return
    }

    telemetrySettled = true
    const completedAt = new Date().toISOString()
    const usageEventResult = buildOpenAIUsageEventFromFailure(
      buildEventBuilderParams({
        apiFamily: params.apiFamily,
        completedAt,
        input: params.input,
        metadata: params.metadata,
        startedAt: params.startedAt,
      }),
      error,
      "STREAM_FINAL",
    )
    warnTelemetryIssues(usageEventResult.warnings)

    if (usageEventResult.event) {
      try {
        await params.telemetryDispatcher.dispatch(usageEventResult.event)
      } catch {
        // Telemetry failures must not change provider call behavior.
      }
    }
  }

  function observeItem(item: unknown) {
    if (params.apiFamily === "OPENAI_RESPONSES") {
      if (isTerminalResponsesCompletedEvent(item)) {
        finalResponsesResponse = item.response as Record<string, unknown>
      }
      return
    }

    observeChatCompletionChunk(item, chatCompletionState)
  }

  return new Proxy(result, {
    get(target, property, receiver) {
      if (property !== Symbol.asyncIterator) {
        return Reflect.get(target, property, receiver)
      }

      return function wrappedAsyncIterator() {
        const originalIterable = target as TResult & AsyncIterable<unknown>
        const originalIterator = originalIterable[Symbol.asyncIterator]()

        return {
          async next(...args: [] | [unknown]) {
            try {
              const iteration = await originalIterator.next(...args)

              if (iteration.done) {
                await dispatchSuccess()
                return iteration
              }

              observeItem(iteration.value)
              return iteration
            } catch (error) {
              await dispatchFailure(error)
              throw error
            }
          },
          async return(value?: unknown) {
            try {
              const iteration = typeof originalIterator.return === "function"
                ? await originalIterator.return(value)
                : { done: true, value }

              await dispatchFailure(createCanceledStreamError())
              return iteration
            } catch (error) {
              await dispatchFailure(error)
              throw error
            }
          },
          async throw(error?: unknown) {
            try {
              if (typeof originalIterator.throw === "function") {
                return await originalIterator.throw(error)
              }

              throw error
            } catch (caughtError) {
              await dispatchFailure(caughtError)
              throw caughtError
            }
          },
          [Symbol.asyncIterator]() {
            return this
          },
        }
      }
    },
  })
}
