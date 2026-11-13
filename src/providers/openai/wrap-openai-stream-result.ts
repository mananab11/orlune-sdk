import {
  buildOpenAIUsageEventFromFailure,
  buildOpenAIUsageEventFromStreamResult,
} from "./build-openai-usage-event.js"
import type { TelemetryDispatcher } from "../../internal/telemetry-dispatcher.js"
import type { UsageApiFamily } from "../../internal/usage-event.js"
import type { OrluneCallMetadata } from "../../types.js"
import { captureTelemetry, reportTelemetryError } from "../../internal/capture-telemetry.js"

type OpenAIStreamWrapperParams = {
  apiFamily: UsageApiFamily
  input: unknown
  metadata: OrluneCallMetadata
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
    state.usage = structuredClone(usage)
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
  let pendingOperations = 0
  let removeAbortListener = () => {}
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

  const dispatchResult = () => captureTelemetry(async () => {
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
    removeAbortListener()

    const usageEventResult = buildOpenAIUsageEventFromStreamResult(
      {
        apiFamily: params.apiFamily,
        completedAt,
        input: params.input,
        metadata: params.metadata,
        startedAt: params.startedAt,
      },
      successSource,
      terminalStatus,
      terminalErrorCode,
    )
    warnTelemetryIssues(usageEventResult.warnings)

    if (usageEventResult.event) {
      await params.telemetryDispatcher.dispatch(usageEventResult.event)
    }
  })

  const dispatchFailure = (error: unknown) => captureTelemetry(async () => {
    if (telemetrySettled) {
      return
    }

    // Closing or failing the iterator cannot undo a completed provider response.
    if (completionObserved) {
      await dispatchResult()
      return
    }

    telemetrySettled = true
    removeAbortListener()
    const completedAt = new Date().toISOString()
    const usageEventResult = buildOpenAIUsageEventFromFailure(
      {
        apiFamily: params.apiFamily,
        completedAt,
        input: params.input,
        metadata: params.metadata,
        startedAt: params.startedAt,
      },
      error,
      "STREAM_FINAL",
    )
    warnTelemetryIssues(usageEventResult.warnings)

    if (usageEventResult.event) {
      await params.telemetryDispatcher.dispatch(usageEventResult.event)
    }
  })

  function observeItem(item: unknown) {
    if (params.apiFamily === "OPENAI_RESPONSES") {
      if (isTerminalResponsesEvent(item)) {
        const response = item.response as Record<string, unknown>
        // Retain only telemetry fields, detached before exposing the event to the caller.
        finalResponsesResponse = structuredClone({
          id: response.id, model: response.model, usage: response.usage,
          _request_id: response._request_id,
          service_tier: response.service_tier, error: response.error,
          incomplete_details: response.incomplete_details,
          output: Array.isArray(response.output) ? response.output.filter(isRecord).map(
            item => ({ type: item.type, finish_reason: item.finish_reason }),
          ) : undefined,
        })
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

  const onAbort = () => {
    // Native iteration also aborts during cleanup. Let an in-flight operation
    // report its real result/error rather than racing it with cancellation.
    if (pendingOperations === 0) void dispatchFailure(createCanceledStreamError())
  }

  function wrappedAsyncIterator() {
    const originalIterator = createIterator()

    return {
      async next(...args: [] | [unknown]) {
        pendingOperations++
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

          try {
            if (!telemetrySettled) observeItem(iteration.value)
          } catch {
            telemetrySettled = true
            removeAbortListener()
            reportTelemetryError()
          }
          return iteration
        } catch (error) {
          await dispatchFailure(error)
          throw error
        } finally {
          pendingOperations--
          if (controller?.signal.aborted) onAbort()
        }
      },
      async return(value?: unknown) {
        pendingOperations++
        try {
          const iteration = typeof originalIterator.return === "function"
            ? await originalIterator.return(value)
            : { done: true, value }

          await dispatchFailure(createCanceledStreamError())
          return iteration
        } catch (error) {
          await dispatchFailure(error)
          throw error
        } finally {
          pendingOperations--
          if (controller?.signal.aborted) onAbort()
        }
      },
      async throw(error?: unknown) {
        pendingOperations++
        try {
          if (typeof originalIterator.throw === "function") {
            return await originalIterator.throw(error)
          }

          throw error
        } catch (caughtError) {
          await dispatchFailure(caughtError)
          throw caughtError
        } finally {
          pendingOperations--
          if (controller?.signal.aborted) onAbort()
        }
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
  }

  const iteratorDescriptor = Object.getOwnPropertyDescriptor(result, Symbol.asyncIterator)
  if (!hasNativeFactory && iteratorDescriptor?.configurable === false &&
      ("value" in iteratorDescriptor && iteratorDescriptor.writable === false)) {
    reportTelemetryError()
    return result
  }
  const observed = hasNativeFactory ? result : new Proxy(result, {
    get(target, property, receiver) {
      return property === Symbol.asyncIterator
        ? wrappedAsyncIterator
        : Reflect.get(target, property, receiver)
    },
  })
  try {
    if (hasNativeFactory && !Reflect.set(result, "iterator", wrappedAsyncIterator)) {
      reportTelemetryError()
      return result
    }
    if (controller) {
      removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort)
      controller.signal.addEventListener("abort", onAbort, { once: true })
      if (controller.signal.aborted) onAbort()
    }
    return observed
  } catch {
    telemetrySettled = true
    try { removeAbortListener() } catch { /* Best effort cleanup. */ }
    reportTelemetryError()
    return result
  }
}
