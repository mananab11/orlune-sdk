import type { EvaluationOptions, EvaluationRequest, EvaluationResult, GuardrailOptions } from "./guardrails.js"
import type { WrappedProviderClient } from "./providers/provider-client-types.js"
import type { TelemetryMode } from "./options.js"

export type CreateClientOptions = {
  apiKey: string
  /** Orlune API origin. Defaults to production; override for local testing. */
  baseURL?: string
  /** Timeout for each Orlune HTTP attempt, in milliseconds. Defaults to 5000. */
  timeoutMs?: number
  telemetryDelivery?: TelemetryDeliveryOptions
  /** Automatic checks for wrapped providers. */
  guardrails?: GuardrailOptions
}

export type OrluneActivityMetadata = {
  id: string
  type: string
}

export type OrluneWrapDefaults = {
  feature?: string
}

export type OrluneCallMetadata = {
  customerId: string
  feature?: string
  eventType: string
  activity: OrluneActivityMetadata
}

export type UsageApiFamily =
  | "OPENAI_RESPONSES"
  | "OPENAI_CHAT_COMPLETIONS"
  | "ANTHROPIC_MESSAGES"

export type TelemetryDeliveryMode = typeof TelemetryMode[keyof typeof TelemetryMode]

export type SyncTelemetryDeliveryOptions = {
  mode: typeof TelemetryMode.Sync
}

export type BackgroundFlushTelemetryDeliveryOptions = {
  mode: typeof TelemetryMode.BackgroundFlush
  maxQueueSize?: number
  flushIntervalMs?: number
  maxRetries?: number
}

export type TelemetryDeliveryOptions =
  | SyncTelemetryDeliveryOptions
  | BackgroundFlushTelemetryDeliveryOptions

export type WrapClientOptions = {
  defaults?: OrluneWrapDefaults
}

export type WrappedClientRequestMetadata = {
  orlune_metadata: OrluneCallMetadata
}

export type OrluneClient = {
  evaluate(request: EvaluationRequest, options?: EvaluationOptions): Promise<EvaluationResult>
  wrap<TClient extends object>(
    client: TClient,
    options?: WrapClientOptions,
  ): WrappedProviderClient<TClient>
  flush(): Promise<void>
}
