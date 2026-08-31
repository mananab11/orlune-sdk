import type { TelemetryDispatcher } from "../internal/telemetry-dispatcher.js"
import type { WrapClientOptions } from "../types.js"

export type WrapProviderClientOptions = {
  orluneOptions?: WrapClientOptions
  telemetryDispatcher: TelemetryDispatcher
}

export type ProviderAdapter = {
  wrap<TClient extends object>(client: TClient, options: WrapProviderClientOptions): TClient
}
