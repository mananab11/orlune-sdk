import type {
  OpenAIUsageEvent,
  UsageCaptureType,
  UsageApiFamily,
  UsageEventOperation,
  UsageEventRequest,
  UsageEventStatus,
} from "../../internal/usage-event.js"
import type { OrluneCallMetadata } from "../../types.js"

type OpenAIEventBuilderParams = {
  apiFamily: UsageApiFamily
  metadata: OrluneCallMetadata
  startedAt: string
  completedAt: string
  input: unknown
}

type OpenAIUsageEventBuildResult = {
  event: UsageEventRequest | null
  warnings: string[]
}

type OpenAIErrorLike = {
  code?: unknown
  name?: unknown
  status?: unknown
  request_id?: unknown
  requestID?: unknown
  requestId?: unknown
}

type OpenAIResponseLike = {
  id?: unknown
  _request_id?: unknown
  model?: unknown
  usage?: unknown
  output?: unknown
  choices?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function getUsageRecord(value: unknown): Record<string, unknown> {
  // Queued telemetry must not share mutable usage details with the caller.
  return isRecord(value) ? structuredClone(value) : {}
}

function pricingContext(input: unknown, result?: unknown) {
  const request = isRecord(input) ? input : {}
  const response = isRecord(result) ? result : {}
  const serviceTier = getString(response.service_tier)
  const requestedServiceTier = getString(request.service_tier) ?? "auto"
  const tools = Array.isArray(request.tools) ? request.tools : []
  const output = Array.isArray(response.output) ? response.output : []
  // Only capture billing context, never tool arguments or generated content.
  const hasAdditionalCharges = tools.some(tool => isRecord(tool) && !["function", "custom"].includes(String(tool.type))) ||
    output.some(item => isRecord(item) && ["web_search_call", "file_search_call", "code_interpreter_call", "image_generation_call"].includes(String(item.type))) ||
    request.web_search_options !== undefined || (typeof request.model === "string" && request.model.includes("search"))
  return { ...(serviceTier ? { serviceTier } : {}), requestedServiceTier, hasAdditionalCharges }
}

function createGeneratedRequestId(): string {
  return `orlune_req_${crypto.randomUUID()}`
}

function deriveOpenAIRequestId(result: unknown, error: unknown): string | undefined {
  if (isRecord(result)) {
    return (
      getString((result as OpenAIResponseLike)._request_id) ??
      getString((result as OpenAIResponseLike).id)
    )
  }

  if (isRecord(error)) {
    return (
      getString((error as OpenAIErrorLike).requestID) ??
      getString((error as OpenAIErrorLike).request_id) ??
      getString((error as OpenAIErrorLike).requestId)
    )
  }

  return undefined
}

function deriveModel(result: unknown, input: unknown): string | undefined {
  if (isRecord(result)) {
    const model = getString((result as OpenAIResponseLike).model)

    if (model) {
      return model
    }
  }

  if (isRecord(input)) {
    return getString(input.model)
  }

  return undefined
}

function deriveFinishReason(result: unknown, apiFamily: UsageApiFamily): string | undefined {
  if (!isRecord(result)) {
    return undefined
  }

  if (apiFamily === "OPENAI_CHAT_COMPLETIONS") {
    const rawChoices = (result as OpenAIResponseLike).choices
    const choices = Array.isArray(rawChoices)
      ? rawChoices
      : []
    const firstChoice = choices[0]

    if (!isRecord(firstChoice)) {
      return undefined
    }

    return getString(firstChoice.finish_reason)
  }

  const rawOutput = (result as OpenAIResponseLike).output
  const output = Array.isArray(rawOutput)
    ? rawOutput
    : []
  const firstOutput = output[0]

  if (!isRecord(firstOutput)) {
    return undefined
  }

  return getString(firstOutput.finish_reason)
}

function deriveFailureStatus(error: unknown): UsageEventStatus {
  if (!isRecord(error)) {
    return "FAILED"
  }

  const name = getString((error as OpenAIErrorLike).name)
  // OpenAI error subclasses may retain Error.name rather than their class name.
  const className = typeof error.constructor === "function" ? error.constructor.name : undefined

  if (name === "AbortError" || name === "APIUserAbortError" || className === "APIUserAbortError") {
    return "CANCELED"
  }

  const status = typeof (error as OpenAIErrorLike).status === "number"
    ? (error as OpenAIErrorLike).status
    : undefined

  if (name === "APIConnectionTimeoutError" || className === "APIConnectionTimeoutError" || status === 408) {
    return "TIMED_OUT"
  }

  if (status === 429) {
    return "RATE_LIMITED"
  }

  return "FAILED"
}

function resolveRequiredString(params: {
  value: string | undefined
  fallback: string
  warnings: string[]
  warningMessage: string
}): string {
  if (params.value) {
    return params.value
  }

  params.warnings.push(params.warningMessage)
  return params.fallback
}

function buildOperation(
  metadata: OrluneCallMetadata,
  startedAt: string,
  completedAt: string,
  status: UsageEventStatus,
): UsageEventOperation {
  const operation: UsageEventOperation = {
    id: metadata.activity.id,
    type: metadata.activity.type,
    status:
      status === "SUCCEEDED"
        ? "SUCCEEDED"
        : status === "CANCELED"
          ? "CANCELED"
          : "FAILED",
    startedAt,
    completedAt,
  }

  return operation
}

function buildBaseEvent(
  params: OpenAIEventBuilderParams,
  result: unknown,
  status: UsageEventStatus,
  captureType: UsageCaptureType,
  errorCode?: string,
): OpenAIUsageEventBuildResult {
  const warnings: string[] = []
  const customerId = getString(params.metadata?.customerId)

  if (!customerId) {
    return {
      event: null,
      warnings: [
        "Skipping OpenAI telemetry because customerId is missing.",
      ],
    }
  }

  const requestId = resolveRequiredString({
    value: deriveOpenAIRequestId(result, undefined),
    fallback: createGeneratedRequestId(),
    warnings,
    warningMessage: "OpenAI request id was missing. Generated an internal requestId fallback.",
  })
  const feature = resolveRequiredString({
    value: getString(params.metadata?.feature),
    fallback: "UNKNOWN",
    warnings,
    warningMessage: "Feature was missing. Falling back to 'UNKNOWN'.",
  })
  const model = deriveModel(result, params.input)
  const eventType = getString(params.metadata?.eventType)

  if (!eventType) {
    return {
      event: null,
      warnings: [
        ...warnings,
        "Skipping OpenAI telemetry because eventType is missing.",
      ],
    }
  }

  if (!model) {
    return {
      event: null,
      warnings: [
        ...warnings,
        "Skipping OpenAI telemetry because model is missing.",
      ],
    }
  }

  const event: OpenAIUsageEvent = {
    provider: "OPENAI",
    requestId,
    occurredAt: params.completedAt,
    customerId,
    feature,
    eventType,
    captureType,
    apiFamily: params.apiFamily,
    model,
    status,
    operation: buildOperation(params.metadata, params.startedAt, params.completedAt, status),
    providerEvent: {
      openai: {
        usage: isRecord(result) ? getUsageRecord((result as OpenAIResponseLike).usage) : {},
        ...pricingContext(params.input, result),
      },
    },
  }

  if (errorCode) {
    event.errorCode = errorCode
  }

  const finishReason = deriveFinishReason(result, params.apiFamily)

  if (finishReason) {
    event.providerEvent.openai.finishReason = finishReason
  }

  return {
    event: { event },
    warnings,
  }
}

export function buildOpenAIUsageEventFromSuccess(
  params: OpenAIEventBuilderParams,
  result: unknown,
): OpenAIUsageEventBuildResult {
  if (params.apiFamily === "OPENAI_RESPONSES" && isRecord(result)) {
    const status = getString(result.status)
    if (status === "queued" || status === "in_progress") {
      return {
        event: null,
        warnings: ["Skipping non-terminal OpenAI response telemetry. Background Responses completion tracking is not supported."],
      }
    }
    if (status === "failed" || status === "incomplete" || status === "cancelled") {
      const reason = status === "incomplete"
        ? (isRecord(result.incomplete_details) ? getString(result.incomplete_details.reason) : undefined) ?? "RESPONSE_INCOMPLETE"
        : isRecord(result.error) ? getString(result.error.code) : undefined
      return buildBaseEvent(params, result, status === "cancelled" ? "CANCELED" : "FAILED", "RESPONSE", reason)
    }
  }
  return buildBaseEvent(params, result, "SUCCEEDED", "RESPONSE")
}

export function buildOpenAIUsageEventFromStreamResult(
  params: OpenAIEventBuilderParams,
  result: unknown,
  status: UsageEventStatus,
  errorCode?: string,
): OpenAIUsageEventBuildResult {
  return buildBaseEvent(params, result, status, "STREAM_FINAL", errorCode)
}

export function buildOpenAIUsageEventFromFailure(
  params: OpenAIEventBuilderParams,
  error: unknown,
  captureType: UsageCaptureType = "RESPONSE",
): OpenAIUsageEventBuildResult {
  const warnings: string[] = []
  const customerId = getString(params.metadata?.customerId)

  if (!customerId) {
    return {
      event: null,
      warnings: [
        "Skipping OpenAI telemetry because customerId is missing.",
      ],
    }
  }

  const requestId = resolveRequiredString({
    value: deriveOpenAIRequestId(undefined, error),
    fallback: createGeneratedRequestId(),
    warnings,
    warningMessage: "OpenAI request id was missing on failure. Generated an internal requestId fallback.",
  })
  const feature = resolveRequiredString({
    value: getString(params.metadata?.feature),
    fallback: "UNKNOWN",
    warnings,
    warningMessage: "Feature was missing. Falling back to 'UNKNOWN'.",
  })
  const model = deriveModel(undefined, params.input)
  const eventType = getString(params.metadata?.eventType)

  if (!eventType) {
    return {
      event: null,
      warnings: [
        ...warnings,
        "Skipping OpenAI telemetry because eventType is missing.",
      ],
    }
  }

  if (!model) {
    return {
      event: null,
      warnings: [
        ...warnings,
        "Skipping OpenAI telemetry because model is missing.",
      ],
    }
  }

  const status = deriveFailureStatus(error)
  const event: OpenAIUsageEvent = {
    provider: "OPENAI",
    requestId,
    occurredAt: params.completedAt,
    customerId,
    feature,
    eventType,
    captureType,
    apiFamily: params.apiFamily,
    model,
    status,
    operation: buildOperation(params.metadata, params.startedAt, params.completedAt, status),
    providerEvent: {
      openai: {
        usage: {},
        ...pricingContext(params.input),
      },
    },
  }

  const errorCode = isRecord(error) ? getString((error as OpenAIErrorLike).code) : undefined

  if (errorCode) {
    event.errorCode = errorCode
  }

  return {
    event: { event },
    warnings,
  }
}

export type { OpenAIUsageEventBuildResult }
