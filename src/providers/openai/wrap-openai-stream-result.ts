import {
  buildOpenAIUsageEventFromFailure,
  buildOpenAIUsageEventFromStreamResult,
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

type ResponsesTerminalEvent = {
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

function isTerminalResponsesEvent(event: unknown): event is ResponsesTerminalEvent {
  return isRecord(event) && ["response.completed", "response.incomplete", "response.failed"].includes(String(event.type)) && isRecord(event.response)
}

function createChatCompletionStreamSnapshot(state: {
  serviceTier?: string
  requestId?: string
  model?: string
  usage?: Record<string, unknown>
  finishReason?: string
}): Record<string, unknown> | null {
  if (!state.requestId && !state.model && !state.usage && !state.finishReason) {
    return null
  }

  return {
    ...(state.serviceTier ? { service_tier: state.serviceTier } : {}),
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
    serviceTier?: string
    requestId?: string
    model?: string
    usage?: Record<string, unknown>
    finishReason?: string
  },
) {
  if (!isRecord(chunk)) {
    return
  }

  const serviceTier = getString(chunk.service_tier)
  if (serviceTier) state.serviceTier = serviceTier

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
  let completionObserved = false
  const finishedChoices = new Set<number>()
  const expectedChoices = isRecord(params.input) && typeof params.input.n === "number"
    ? params.input.n : 1
  let terminalStatus: "SUCCEEDED" | "FAILED" = "SUCCEEDED"
  let terminalErrorCode: string | undefined
  const chatCompletionState: {
    serviceTier?: string
    requestId?: string
    model?: string
    usage?: Record<string, unknown>
    finishReason?: string
  } = {}
  let finalResponsesResponse: Record<string, unknown> | null = null

  async function dispatchResult() {
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

    const usageEventResult = buildOpenAIUsageEventFromStreamResult(
      buildEventBuilderParams({
        apiFamily: params.apiFamily,
        completedAt,
        input: params.input,
        metadata: params.metadata,
        startedAt: params.startedAt,
      }),
      successSource,
      terminalStatus,
      terminalErrorCode,
    )
    warnTelemetryIssues(usageEventResult.warnings)

    if (usageEventResult.event) {
      await params.telemetryDispatcher.dispatch(usageEventResult.event)
    }
  }

  async function dispatchFailure(error: unknown) {
    if (telemetrySettled) {
      return
    }

    // Closing or failing the iterator cannot undo a completed provider response.
    if (completionObserved) {
      await dispatchResult()
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
      await params.telemetryDispatcher.dispatch(usageEventResult.event)
    }
  }

  function observeItem(item: unknown) {
    if (params.apiFamily === "OPENAI_RESPONSES") {
      if (isTerminalResponsesEvent(item)) {
        finalResponsesResponse = item.response as Record<string, unknown>
        completionObserved = true
        terminalStatus = item.type === "response.completed" ? "SUCCEEDED" : "FAILED"
        const error = finalResponsesResponse.error
        const incomplete = finalResponsesResponse.incomplete_details
        terminalErrorCode = isRecord(error) ? getString(error.code) : undefined
        if (item.type === "response.incomplete") {
          terminalErrorCode = (isRecord(incomplete) ? getString(incomplete.reason) : undefined) ?? "RESPONSE_INCOMPLETE"
        }
      }
      return
    }

    observeChatCompletionChunk(item, chatCompletionState)
    if (isRecord(item) && Array.isArray(item.choices)) {
      for (const choice of item.choices) {
        if (isRecord(choice) && getString(choice.finish_reason)) {
          const index = typeof choice.index === "number" ? choice.index : 0
          if (Number.isInteger(index) && index >= 0 && index < expectedChoices) finishedChoices.add(index)
        }
      }
    }
    // A choice finishing is not the end of the stream: other choices and usage
    // may follow. The usage-only chunk confirms completion for the whole call.
    if (isRecord(item) && isRecord(item.usage) &&
      Array.isArray(item.choices) && item.choices.length === 0) {
      completionObserved = true
    }
  }

  // Native OpenAI streams use this factory for iteration, tee(), and readable
  // streams. Keep their original receiver so private fields remain accessible.
  const nativeIterator = Reflect.get(result, "iterator")
  const streamController = Reflect.get(result, "controller")
  const controller = streamController instanceof AbortController ? streamController : undefined
  const hasNativeFactory = typeof nativeIterator === "function" && controller !== undefined
  const createIterator = hasNativeFactory
    ? () => nativeIterator.call(result) as AsyncIterator<unknown>
    : () => result[Symbol.asyncIterator]()

  function wrappedAsyncIterator() {
    const originalIterator = createIterator()

    return {
      async next(...args: [] | [unknown]) {
        try {
          const iteration = await originalIterator.next(...args)

          if (iteration.done) {
            if (!completionObserved && controller?.signal.aborted) {
              await dispatchFailure(createCanceledStreamError())
              return iteration
            }
            if (!completionObserved && (params.apiFamily === "OPENAI_RESPONSES" || finishedChoices.size !== expectedChoices)) {
              const error = Object.assign(new Error("OpenAI stream ended before generation finished."), { code: "STREAM_INCOMPLETE" })
              await dispatchFailure(error)
              return iteration
            }
            await dispatchResult()
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

  if (hasNativeFactory) {
    Reflect.set(result, "iterator", wrappedAsyncIterator)
    return result
  }

  return new Proxy(result, {
    get(target, property, receiver) {
      return property === Symbol.asyncIterator
        ? wrappedAsyncIterator
        : Reflect.get(target, property, receiver)
    },
  })
}
