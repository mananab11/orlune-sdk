import type { TelemetryDispatcher } from "../internal/telemetry-dispatcher.js"
import type { OrluneClient, WrapClientOptions } from "../types.js"
import type { GuardrailOptions } from "../guardrails.js"

export type WrapProviderClientOptions = {
  orluneOptions?: WrapClientOptions
  guardrails?: Readonly<GuardrailOptions>
  telemetryDispatcher: TelemetryDispatcher
  evaluate?: OrluneClient["evaluate"]
}

export type ProviderAdapter = {
  provider: string
  matches(client: object): boolean
  wrap(client: object, options: WrapProviderClientOptions): object
}
