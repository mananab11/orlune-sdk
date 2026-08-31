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

export type TelemetryDeliveryMode = "sync" | "manual_flush" | "background_flush"

export type TelemetryDeliveryOptions = {
  mode: TelemetryDeliveryMode
}

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
}
