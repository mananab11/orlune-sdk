export type ClientEnvironment = "production" | "sandbox"

export type CreateClientOptions = {
  apiKey: string
  environment: ClientEnvironment
  telemetryDelivery?: TelemetryDeliveryOptions
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
}

export type BackgroundFlushTelemetryDeliveryOptions = {
  mode: "background_flush"
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
  orlune_metadata?: OrluneCallMetadata
}

export type OrluneClient = {
  wrap<TClient extends object>(
    client: TClient,
    options?: WrapClientOptions,
  ): TClient
  flush(): Promise<void>
}
