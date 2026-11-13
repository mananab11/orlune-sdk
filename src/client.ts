import { createTelemetryDispatcher } from "./internal/telemetry-dispatcher.js"
import { createTelemetryTransport } from "./internal/telemetry-transport.js"
import { createEvaluator } from "./internal/evaluation-transport.js"
import { resolveBaseURL } from "./config.js"
import { getProviderAdapter } from "./providers/get-provider-adapter.js"
import type { WrappedProviderClient } from "./providers/provider-client-types.js"
import type {
  CreateClientOptions,
  OrluneClient as OrluneClientInstance,
  WrapClientOptions,
} from "./types.js"

const ORLUNE_WRAPPED = Symbol.for("orlune.wrapped")

function assertNonEmptyString(value: string, fieldName: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} is required.`)
  }
}

function validateTimeout(value: number | undefined, field: string) {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647)) {
    throw new Error(`${field} must be a positive integer no greater than 2147483647.`)
  }
}

function wrapSettings(options?: WrapClientOptions) {
  return JSON.stringify([
    options?.defaults?.feature,
    options?.guardrails?.enabled ?? false,
    options?.guardrails?.onError ?? "throw",
    options?.guardrails?.timeoutMs,
  ])
}

function markWrapped(client: object, owner: symbol, settings: string) {
  Object.defineProperty(client, ORLUNE_WRAPPED, {
    value: Object.freeze({ owner, settings }),
    enumerable: false,
    configurable: false,
    writable: false,
  })
}

/**
 * Creates a client for usage telemetry and optional runtime guardrail checks.
 */
export function OrluneClient(options: CreateClientOptions): OrluneClientInstance {
  assertNonEmptyString(options.apiKey, "apiKey")
  if ("environment" in options) throw new Error("environment is no longer supported. Use baseURL for a nonproduction API origin.")
  validateTimeout(options.evaluationTimeoutMs, "evaluationTimeoutMs")
  const owner = Symbol("orlune.client")

  const baseURL = resolveBaseURL(options.baseURL)
  const endpoint = new URL("/v1/events", baseURL).href
  const evaluate = createEvaluator(options.apiKey, new URL("/v1/guardrails/evaluate", baseURL).href, options.evaluationTimeoutMs)
  const transport = createTelemetryTransport({
    apiKey: options.apiKey,
    endpoint,
    ...(options.telemetryDelivery?.timeoutMs !== undefined
      ? { timeoutMs: options.telemetryDelivery.timeoutMs } : {}),
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

  return {
    evaluate,
    wrap<TClient extends object>(client: TClient, options?: WrapClientOptions): WrappedProviderClient<TClient> {
      if (options?.guardrails !== undefined) {
        const settings = options.guardrails
        if (settings === null || typeof settings.enabled !== "boolean") {
          throw new Error("guardrails.enabled must be a boolean.")
        }
        if (settings.onError !== undefined && settings.onError !== "throw" && settings.onError !== "allow") {
          throw new Error('guardrails.onError must be "throw" or "allow".')
        }
        validateTimeout(settings.timeoutMs, "guardrails.timeoutMs")
      }
      const existing = Reflect.get(client, ORLUNE_WRAPPED) as { owner?: symbol; settings?: string } | undefined
      if (existing !== undefined) {
        if (existing.owner !== owner) {
          throw new Error("This provider client is already wrapped by another Orlune client. Use a separate provider client.")
        }
        if (options !== undefined && existing.settings !== wrapSettings(options)) {
          throw new Error("This provider client is already wrapped with different settings. Configure it on the original wrap() call.")
        }
        return client as WrappedProviderClient<TClient>
      }

      const providerAdapter = getProviderAdapter(client)

      if (providerAdapter === null) {
        throw new Error("Unsupported provider client passed to wrap().")
      }

      const savedOptions = options === undefined ? undefined : structuredClone(options)
      const wrappedClient = savedOptions === undefined
        ? providerAdapter.wrap(client, {
            telemetryDispatcher,
            evaluate,
          })
        : providerAdapter.wrap(client, {
            orluneOptions: savedOptions,
            telemetryDispatcher,
            evaluate,
          })

      markWrapped(wrappedClient, owner, wrapSettings(savedOptions))

      return wrappedClient as WrappedProviderClient<TClient>
    },
    async flush(): Promise<void> {
      await telemetryDispatcher.flush()
    },
  }
}
