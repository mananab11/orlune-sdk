import type { TelemetryDeliveryOptions } from "../types.js"
import type { UsageEventRequest } from "./usage-event.js"
import type { TelemetryTransport } from "./telemetry-transport.js"

type TelemetryDispatcher = {
  dispatch(event: UsageEventRequest): Promise<void>
}

type CreateTelemetryDispatcherParams = {
  telemetryDelivery?: TelemetryDeliveryOptions
  transport: TelemetryTransport
}

function getTelemetryDeliveryMode(
  telemetryDelivery?: TelemetryDeliveryOptions,
): TelemetryDeliveryOptions["mode"] {
  return telemetryDelivery?.mode ?? "sync"
}

export function createTelemetryDispatcher(
  params: CreateTelemetryDispatcherParams,
): TelemetryDispatcher {
  const mode = getTelemetryDeliveryMode(params.telemetryDelivery)

  if (mode === "sync") {
    return {
      async dispatch(event: UsageEventRequest): Promise<void> {
        await params.transport.send(event)
      },
    }
  }

  return {
    async dispatch(event: UsageEventRequest): Promise<void> {
      void event
    },
  }
}

export type { TelemetryDispatcher }
