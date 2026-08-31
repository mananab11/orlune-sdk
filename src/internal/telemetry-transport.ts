import type { UsageEventRequest } from "./usage-event.js"

type TelemetryTransport = {
  send(event: UsageEventRequest): Promise<void>
}

type CreateTelemetryTransportParams = {
  apiKey: string
  endpoint: string
}

export function createTelemetryTransport(
  params: CreateTelemetryTransportParams,
): TelemetryTransport {
  return {
    async send(event: UsageEventRequest): Promise<void> {
      const response = await fetch(params.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify(event),
      })

      if (!response.ok) {
        throw new Error(`Telemetry request failed with status ${response.status}.`)
      }
    },
  }
}

export type { TelemetryTransport }
