import test from "node:test"
import assert from "node:assert/strict"

import { OrluneClient } from "../dist/index.js"

function createOpenAIResponsesClient() {
  return {
    baseURL: "https://api.openai.com/v1",
    responses: {
      async create(input) {
        assert.equal("orlune_metadata" in input, false)

        return {
          _request_id: "req_delivery_123",
          id: "resp_delivery_123",
          model: "gpt-4.1-mini",
          output: [
            {
              finish_reason: "stop",
            },
          ],
          usage: {
            input_tokens: 25,
            output_tokens: 10,
            total_tokens: 35,
          },
        }
      },
    },
  }
}

test("background telemetry snapshots usage without changing the provider response", async t => {
  const events = []
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    events.push(JSON.parse(init.body).event)
    return Response.json({})
  })
  const usage = {
    input_tokens: 25,
    output_tokens: 10,
    total_tokens: 35,
    input_tokens_details: { cached_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 3 },
  }
  const originalUsage = structuredClone(usage)
  const response = { _request_id: "req_snapshot", model: "gpt-4.1-mini", usage }
  const orlune = OrluneClient({
    apiKey: "test",
    environment: "sandbox",
    telemetryDelivery: { mode: "background_flush", flushIntervalMs: 60_000 },
  })
  t.after(() => orlune.flush())
  const openai = orlune.wrap({
    baseURL: "https://api.openai.com/v1",
    responses: { async create() { return response } },
  }, { defaults: { feature: "Usage snapshot" } })

  const result = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: "Hello",
    orlune_metadata: { customerId: "customer", eventType: "MODEL_CALL", activity: { id: "activity", type: "test" } },
  })
  assert.equal(result, response)
  assert.equal(result.usage, usage)
  assert.deepEqual(result.usage, originalUsage)
  assert.equal(events.length, 0)

  result.usage.input_tokens = 999
  result.usage.input_tokens_details.cached_tokens = 999
  result.usage.output_tokens_details.reasoning_tokens = 999
  await orlune.flush()

  assert.equal(events.length, 1)
  assert.deepEqual(events[0].providerEvent.openai.usage, originalUsage)
})

test("background_flush can be explicitly drained with orlune.flush before the timer fires", async () => {
  const sentRequests = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = async (url, init) => {
    sentRequests.push({ url, init })

    return {
      ok: true,
      status: 200,
    }
  }

  try {
    const orlune = OrluneClient({
      apiKey: "orlune_test_key",
      environment: "production",
      telemetryDelivery: {
        mode: "background_flush",
        flushIntervalMs: 60_000,
      },
    })

    const openai = orlune.wrap(createOpenAIResponsesClient(), {
      defaults: {
        feature: "Explicit flush before timer test",
      },
    })

    await openai.responses.create({
      model: "gpt-4.1-mini",
      input: "Hello",
      orlune_metadata: {
        activity: { id: "activity", type: "test" },
        customerId: "customer_explicit_flush_before_timer",
        eventType: "MODEL_CALL",
      },
    })

    assert.equal(sentRequests.length, 0)

    await orlune.flush()

    assert.equal(sentRequests.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("background_flush delivers queued telemetry without explicit flush", async () => {
  const sentRequests = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = async (url, init) => {
    sentRequests.push({ url, init })

    return {
      ok: true,
      status: 200,
    }
  }

  try {
    const orlune = OrluneClient({
      apiKey: "orlune_test_key",
      environment: "production",
      telemetryDelivery: {
        mode: "background_flush",
        flushIntervalMs: 10,
      },
    })

    const openai = orlune.wrap(createOpenAIResponsesClient(), {
      defaults: {
        feature: "Background flush test",
      },
    })

    await openai.responses.create({
      model: "gpt-4.1-mini",
      input: "Hello",
      orlune_metadata: {
        activity: { id: "activity", type: "test" },
        customerId: "customer_background_flush",
        eventType: "MODEL_CALL",
      },
    })

    assert.equal(sentRequests.length, 0)

    await new Promise((resolve) => setTimeout(resolve, 40))

    assert.equal(sentRequests.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("background_flush flushes pending telemetry when orlune.flush is called", async () => {
  const sentRequests = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = async (url, init) => {
    sentRequests.push({ url, init })

    return {
      ok: true,
      status: 200,
    }
  }

  try {
    const orlune = OrluneClient({
      apiKey: "orlune_test_key",
      environment: "production",
      telemetryDelivery: {
        mode: "background_flush",
        flushIntervalMs: 60_000,
      },
    })

    const openai = orlune.wrap(createOpenAIResponsesClient(), {
      defaults: {
        feature: "Explicit flush test",
      },
    })

    await openai.responses.create({
      model: "gpt-4.1-mini",
      input: "Hello",
      orlune_metadata: {
        activity: { id: "activity", type: "test" },
        customerId: "customer_background_explicit_flush",
        eventType: "MODEL_CALL",
      },
    })

    assert.equal(sentRequests.length, 0)

    await orlune.flush()

    assert.equal(sentRequests.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
