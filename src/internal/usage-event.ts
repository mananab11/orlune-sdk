type UsageEventStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED"
  | "TIMED_OUT"
  | "RATE_LIMITED"

type UsageProvider = "OPENAI" | "ANTHROPIC"

type UsageCaptureType = "RESPONSE" | "STREAM_FINAL"

type UsageApiFamily =
  | "OPENAI_RESPONSES"
  | "OPENAI_CHAT_COMPLETIONS"
  | "OPENAI_AUDIO_TRANSCRIPTIONS"
  | "ANTHROPIC_MESSAGES"

type OperationStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED"

type SdkIdentity = {
  name: string
  version: string
}

type UsageEventOperation = {
  id: string
  type?: string
  name?: string
  status?: OperationStatus
  startedAt?: string
  completedAt?: string
  metadata?: Record<string, unknown>
}

type OpenAIUsageEvent = {
  provider: "OPENAI"
  requestId: string
  occurredAt: string
  customerId: string
  feature: string
  eventType: string
  captureType: UsageCaptureType
  apiFamily: UsageApiFamily
  model: string
  status: UsageEventStatus
  errorCode?: string
  sdk?: SdkIdentity
  operation?: UsageEventOperation
  providerEvent: {
    openai: {
      usage: Record<string, unknown>
      finishReason?: string
    }
  }
}

type AnthropicProviderUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

type AnthropicUsageEvent = {
  provider: "ANTHROPIC"
  requestId: string
  occurredAt: string
  customerId: string
  feature: string
  eventType: string
  captureType: UsageCaptureType
  apiFamily: UsageApiFamily
  model: string
  status: UsageEventStatus
  errorCode?: string
  sdk?: SdkIdentity
  operation?: UsageEventOperation
  providerEvent: {
    anthropic: {
      usage: AnthropicProviderUsage
      stopReason?: string
      serverToolUse?: Record<string, number>
    }
  }
}

type UsageEvent = OpenAIUsageEvent | AnthropicUsageEvent

type UsageEventRequest = {
  event: UsageEvent
}

/**
 * Internal SDK event shape mirroring the backend ingestion contract.
 * This stays private to the SDK and should not be exported from the public entrypoint.
 */
export type {
  AnthropicProviderUsage,
  AnthropicUsageEvent,
  OperationStatus,
  OpenAIUsageEvent,
  SdkIdentity,
  UsageApiFamily,
  UsageCaptureType,
  UsageEvent,
  UsageEventOperation,
  UsageEventRequest,
  UsageEventStatus,
  UsageProvider,
}
