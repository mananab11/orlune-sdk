import type {
  BackgroundFlushTelemetryDeliveryOptions,
  TelemetryDeliveryOptions,
} from "../types.js"
import type { UsageEventRequest } from "./usage-event.js"
import type { TelemetryTransport } from "./telemetry-transport.js"

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

function warn(message: string) {
  console.warn(`[orlune] ${message}`)
}

function getTelemetryDeliveryMode(
  telemetryDelivery?: TelemetryDeliveryOptions,
): TelemetryDeliveryOptions["mode"] {
  return telemetryDelivery?.mode ?? "sync"
}

function getQueueOptions(
  telemetryDelivery: BackgroundFlushTelemetryDeliveryOptions | undefined,
) {
  return {
    maxQueueSize: telemetryDelivery?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
    flushIntervalMs:
      telemetryDelivery && telemetryDelivery.mode === "background_flush"
        ? telemetryDelivery.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
        : undefined,
    maxRetries: telemetryDelivery?.maxRetries ?? DEFAULT_MAX_RETRIES,
  }
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
    if (params.telemetryDelivery.mode !== "background_flush") {
      return
    }

    if (flushTimer !== null || options.flushIntervalMs === undefined) {
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
      warn(
        `Telemetry queue reached maxQueueSize=${options.maxQueueSize}. Dropping oldest queued event.`,
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
      } catch (error) {
        entry.attemptCount += 1

        if (entry.attemptCount > options.maxRetries) {
          const requestId = entry.event.event.requestId
          const message = error instanceof Error ? error.message : "Unknown telemetry error."
          warn(
            `Dropping telemetry event after ${options.maxRetries} retries for requestId=${requestId}. ${message}`,
          )
          return
        }

        const backoffMs = 250 * 2 ** (entry.attemptCount - 1)
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
        await params.transport.send(event)
      },
      async flush(): Promise<void> {
        return
      },
    }
  }

  return createQueuedTelemetryDispatcher({
    ...params,
    telemetryDelivery:
      params.telemetryDelivery?.mode === "background_flush"
        ? params.telemetryDelivery
        : { mode: "background_flush" },
  })
}

export type { TelemetryDispatcher }
