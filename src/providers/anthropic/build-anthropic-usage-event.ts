import type { UsageEventRequest, UsageEventStatus, UsageCaptureType } from "../../internal/usage-event.js"
import type { OrluneCallMetadata } from "../../types.js"
import { record, text } from "./anthropic-shapes.js"

export function anthropicFailureStatus(error: unknown): UsageEventStatus {
  const value = record(error)
  const name = text(value.name)
  const className = error instanceof Error ? error.constructor.name : undefined
  if (name === "AbortError" || name === "APIUserAbortError" || className === "APIUserAbortError") return "CANCELED"
  if (name === "APIConnectionTimeoutError" || className === "APIConnectionTimeoutError" || value.status === 408) return "TIMED_OUT"
  if (value.status === 429 || value.type === "rate_limit_error" ||
      record(record(value.error).error).type === "rate_limit_error") return "RATE_LIMITED"
  return "FAILED"
}

export type AnthropicEventContext = {
  metadata: OrluneCallMetadata
  input: unknown
  startedAt: string
  captureType: UsageCaptureType
}

export function buildAnthropicUsageEvent(
  context: AnthropicEventContext,
  result: unknown,
  status: UsageEventStatus,
  error?: unknown,
): UsageEventRequest | null {
  const { metadata, startedAt, captureType } = context
  const input = record(context.input)
  const response = record(result)
  const failure = record(error)
  const customerId = text(metadata.customerId)
  const eventType = text(metadata.eventType)
  const model = text(response.model) ?? text(input.model)
  if (!customerId || !eventType || !model) {
    console.error("[orlune] Skipping Anthropic telemetry: customerId, eventType, or model missing.")
    return null
  }
  const completedAt = new Date().toISOString()
  const requestId = text(response._request_id) ?? text(response.id) ?? text(failure.requestID) ?? text(failure.request_id)
    ?? `orlune_req_${crypto.randomUUID()}`
  const stopReason = text(response.stop_reason)
  const requestedServiceTier = text(input.service_tier)
  const requestedInferenceGeo = text(input.inference_geo)
  const requestedSpeed = text(input.speed)
  const errorCode = text(failure.errorCode) ?? text(failure.code) ?? text(failure.type)
    ?? text(record(record(failure.error).error).type)
  return { event: {
    provider: "ANTHROPIC", apiFamily: "ANTHROPIC_MESSAGES", captureType,
    requestId, occurredAt: completedAt, customerId, eventType, model, status,
    feature: text(metadata.feature) ?? "UNKNOWN",
    ...(errorCode ? { errorCode } : {}),
    operation: {
      id: metadata.activity.id,
      type: metadata.activity.type,
      startedAt, completedAt,
      status: status === "SUCCEEDED" ? "SUCCEEDED" : status === "CANCELED" ? "CANCELED" : "FAILED",
    },
    providerEvent: { anthropic: {
      // Take a snapshot before returning mutable provider data to the application.
      usage: structuredClone(record(response.usage)),
      ...(stopReason ? { stopReason } : {}),
      ...(requestedServiceTier ? { requestedServiceTier } : {}),
      ...(requestedInferenceGeo ? { requestedInferenceGeo } : {}),
      ...(requestedSpeed ? { requestedSpeed } : {}),
    } },
  } }
}
