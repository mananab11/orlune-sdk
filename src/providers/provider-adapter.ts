import type { TelemetryDispatcher } from "../internal/telemetry-dispatcher.js"
import type { OrluneClient, WrapClientOptions } from "../types.js"

export type WrapProviderClientOptions = {
  orluneOptions?: WrapClientOptions
  telemetryDispatcher: TelemetryDispatcher
  evaluate?: OrluneClient["evaluate"]
}

export type ProviderAdapter = {
  provider: string
  matches(client: object): boolean
  wrap(client: object, options: WrapProviderClientOptions): object
}
