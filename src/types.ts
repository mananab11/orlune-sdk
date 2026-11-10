import type { EvaluationOptions, EvaluationRequest, EvaluationResult, GuardrailOptions } from "./guardrails.js"
import type { WrappedProviderClient } from "./providers/provider-client-types.js"

export type ClientEnvironment = "production" | "development" | "sandbox"

export type CreateClientOptions = {
  apiKey: string
  environment: ClientEnvironment
  telemetryDelivery?: TelemetryDeliveryOptions
  evaluationTimeoutMs?: number
}

export type OrluneActivityMetadata = {
  id?: string
  type?: string
  name?: string
}

export type OrluneWrapDefaults = {
  feature?: string
  activity?: OrluneActivityMetadata
}

export type OrluneCallMetadata = {
  customerId?: string
  feature?: string
  eventType?: string
  activity?: OrluneActivityMetadata
}

export type UsageApiFamily =
  | "OPENAI_RESPONSES"
  | "OPENAI_CHAT_COMPLETIONS"
  | "OPENAI_AUDIO_TRANSCRIPTIONS"
  | "ANTHROPIC_MESSAGES"

export type TelemetryDeliveryMode = "sync" | "background_flush"

export type SyncTelemetryDeliveryOptions = {
  mode: "sync"
  /** Per-send timeout in milliseconds. Defaults to 5000. */
  timeoutMs?: number
}

export type BackgroundFlushTelemetryDeliveryOptions = {
  mode: "background_flush"
  /** Per-send timeout in milliseconds, including each retry. Defaults to 5000. */
  timeoutMs?: number
  maxQueueSize?: number
  flushIntervalMs?: number
  maxRetries?: number
}

export type TelemetryDeliveryOptions =
  | SyncTelemetryDeliveryOptions
  | BackgroundFlushTelemetryDeliveryOptions

export type WrapClientOptions = {
  defaults?: OrluneWrapDefaults
  guardrails?: GuardrailOptions
}

export type WrappedClientRequestMetadata = {
  orlune_metadata?: OrluneCallMetadata
}

export type OrluneClient = {
  evaluate(request: EvaluationRequest, options?: EvaluationOptions): Promise<EvaluationResult>
  wrap<TClient extends object>(
    client: TClient,
    options?: WrapClientOptions,
  ): WrappedProviderClient<TClient>
  flush(): Promise<void>
}
