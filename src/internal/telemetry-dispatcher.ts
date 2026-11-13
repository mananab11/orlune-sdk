import type {
  BackgroundFlushTelemetryDeliveryOptions,
  TelemetryDeliveryOptions,
} from "../types.js"
import type { UsageEventRequest } from "./usage-event.js"
import type { TelemetryTransport } from "./telemetry-transport.js"
import { reportTelemetryError } from "./capture-telemetry.js"

type TelemetryDispatcher = {
  dispatch(event: UsageEventRequest): Promise<void>
  flush(): Promise<void>
}

type CreateTelemetryDispatcherParams = {
  telemetryDelivery?: TelemetryDeliveryOptions
  transport: TelemetryTransport
}

type QueuedTelemetryEntry = {
  attemptCount: number
  event: UsageEventRequest
}

const DEFAULT_MAX_QUEUE_SIZE = 500
const DEFAULT_FLUSH_INTERVAL_MS = 1000
const DEFAULT_MAX_RETRIES = 2

function getTelemetryDeliveryMode(
  telemetryDelivery?: TelemetryDeliveryOptions,
): TelemetryDeliveryOptions["mode"] {
  return telemetryDelivery?.mode ?? "sync"
}

function getQueueOptions(
  telemetryDelivery: BackgroundFlushTelemetryDeliveryOptions,
) {
  const options = {
    maxQueueSize: telemetryDelivery.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
    flushIntervalMs: telemetryDelivery.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    maxRetries: telemetryDelivery.maxRetries ?? DEFAULT_MAX_RETRIES,
  }
  for (const [field, value] of Object.entries(options)) {
    const min = field === "maxRetries" ? 0 : 1
    if (!Number.isSafeInteger(value) || value < min || (field === "flushIntervalMs" && value > 2_147_483_647)) {
      throw new Error(`telemetryDelivery.${field} must be ${min === 0 ? "a non-negative" : "a positive"} safe integer${field === "flushIntervalMs" ? " no greater than 2147483647" : ""}.`)
    }
  }
  return options
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function createQueuedTelemetryDispatcher(
  params: CreateTelemetryDispatcherParams & {
    telemetryDelivery: BackgroundFlushTelemetryDeliveryOptions
  },
): TelemetryDispatcher {
  const queue: QueuedTelemetryEntry[] = []
  const options = getQueueOptions(params.telemetryDelivery)
  let flushPromise: Promise<void> | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function clearFlushTimer() {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  function scheduleBackgroundFlush() {
    if (flushTimer !== null) {
      return
    }

    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, options.flushIntervalMs)
  }

  function enqueue(event: UsageEventRequest) {
    if (queue.length >= options.maxQueueSize) {
      queue.shift()
      reportTelemetryError(
        "[orlune] Telemetry queue full; oldest queued event dropped.",
      )
    }

    queue.push({
      attemptCount: 0,
      event,
    })
  }

  async function sendWithRetries(entry: QueuedTelemetryEntry) {
    while (true) {
      try {
        await params.transport.send(entry.event)
        return
      } catch {
        entry.attemptCount += 1

        if (entry.attemptCount > options.maxRetries) {
          reportTelemetryError("[orlune] Telemetry delivery failed; retries exhausted.")
          return
        }

        const backoffMs = Math.min(30_000, 250 * 2 ** Math.min(entry.attemptCount - 1, 7))
        await delay(backoffMs)
      }
    }
  }

  async function drainQueue() {
    while (queue.length > 0) {
      const entry = queue.shift()

      if (!entry) {
        return
      }

      await sendWithRetries(entry)
    }
  }

  async function flush(): Promise<void> {
    clearFlushTimer()

    if (flushPromise !== null) {
      await flushPromise
      return
    }

    flushPromise = (async () => {
      try {
        await drainQueue()
      } finally {
        flushPromise = null

        if (queue.length > 0) {
          scheduleBackgroundFlush()
        }
      }
    })()

    await flushPromise
  }

  return {
    async dispatch(event: UsageEventRequest): Promise<void> {
      enqueue(event)
      scheduleBackgroundFlush()
    },
    flush,
  }
}

export function createTelemetryDispatcher(
  params: CreateTelemetryDispatcherParams,
): TelemetryDispatcher {
  const mode = getTelemetryDeliveryMode(params.telemetryDelivery)

  if (mode === "sync") {
    return {
      async dispatch(event: UsageEventRequest): Promise<void> {
        try {
          await params.transport.send(event)
        } catch {
          reportTelemetryError("[orlune] Telemetry delivery failed.")
        }
      },
      async flush(): Promise<void> {
        return
      },
    }
  }

  if (mode !== "background_flush") throw new Error("Unsupported telemetryDelivery.mode.")

  return createQueuedTelemetryDispatcher({
    ...params,
    telemetryDelivery:
      params.telemetryDelivery?.mode === "background_flush"
        ? params.telemetryDelivery
        : { mode: "background_flush" },
  })
}

export type { TelemetryDispatcher }
