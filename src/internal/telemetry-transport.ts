import type { UsageEventRequest } from "./usage-event.js"

type TelemetryTransport = {
  send(event: UsageEventRequest): Promise<void>
}

type CreateTelemetryTransportParams = {
  apiKey: string
  endpoint: string
  timeoutMs?: number
}

export function createTelemetryTransport(
  params: CreateTelemetryTransportParams,
): TelemetryTransport {
  const timeoutMs = params.timeoutMs ?? 5000
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("timeoutMs must be a positive integer no greater than 2147483647.")
  }
  return {
    async send(event: UsageEventRequest): Promise<void> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response | undefined
      try {
        response = await fetch(params.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${params.apiKey}`,
          },
          body: JSON.stringify(event),
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`Telemetry request failed with status ${response.status}.`)
        }
      } finally {
        clearTimeout(timer)
        // Only the status matters. Release the unused body without waiting on cleanup.
        try {
          void response?.body?.cancel().catch(() => {})
        } catch {
          // Cleanup must not change delivery status or the provider's outcome.
        }
        controller.abort()
      }
    },
  }
}

export type { TelemetryTransport }
