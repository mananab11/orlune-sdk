import { createTelemetryDispatcher } from "./internal/telemetry-dispatcher.js"
import { createTelemetryTransport } from "./internal/telemetry-transport.js"
import { resolveEventsEndpoint } from "./config.js"
import { getProviderAdapter } from "./providers/get-provider-adapter.js"
import type {
  CreateClientOptions,
  OrluneClient,
  WrapClientOptions,
} from "./types.js"

function assertNonEmptyString(value: string, fieldName: string) {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} is required.`)
  }
}

/**
 * Creates a client configured to send events to the Orlune ingestion API.
 * Event tracking methods will be layered on top of this object next.
 */
export function createClient(options: CreateClientOptions): OrluneClient {
  assertNonEmptyString(options.apiKey, "apiKey")

  const endpoint = resolveEventsEndpoint(options.environment)
  const transport = createTelemetryTransport({
    apiKey: options.apiKey,
    endpoint,
  })
  const telemetryDispatcher =
    options.telemetryDelivery === undefined
      ? createTelemetryDispatcher({
          transport,
        })
      : createTelemetryDispatcher({
          telemetryDelivery: options.telemetryDelivery,
          transport,
        })

  void endpoint

  return {
    wrap<TClient extends object>(client: TClient, options?: WrapClientOptions): TClient {
      const providerAdapter = getProviderAdapter(client)

      if (providerAdapter === null) {
        throw new Error("Unsupported provider client passed to wrap().")
      }

      return options === undefined
        ? providerAdapter.wrap(client, {
            telemetryDispatcher,
          })
        : providerAdapter.wrap(client, {
            orluneOptions: options,
            telemetryDispatcher,
          })
    },
    async flush(): Promise<void> {
      await telemetryDispatcher.flush()
    },
  }
}
