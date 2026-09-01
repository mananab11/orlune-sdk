import test from "node:test"
import assert from "node:assert/strict"

import { OrluneClient } from "../dist/index.js"

test("wrapped OpenAI responses.create strips orlune_metadata and sends telemetry", async () => {
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
    const openaiClient = {
      responses: {
        async create(input) {
          assert.equal("orlune_metadata" in input, false)

          return {
            _request_id: "req_provider_123",
            id: "resp_123",
            model: "gpt-4.1-mini",
            output: [
              {
                finish_reason: "stop",
              },
            ],
            usage: {
              input_tokens: 120,
              output_tokens: 45,
              total_tokens: 165,
            },
          }
        },
      },
    }

    const orlune = OrluneClient({
      apiKey: "orlune_test_key",
      environment: "production",
      telemetryDelivery: {
        mode: "sync",
      },
    })

    const wrappedClient = orlune.wrap(openaiClient, {
      defaults: {
        feature: "Suggestions generation",
      },
    })

    const result = await wrappedClient.responses.create({
      model: "gpt-4.1-mini",
      input: "Hello",
      orlune_metadata: {
        customerId: "customer_123",
        eventType: "MODEL_CALL",
      },
    })

    assert.equal(result.model, "gpt-4.1-mini")
    assert.equal(sentRequests.length, 1)
    assert.equal(
      sentRequests[0].url,
      "https://du37zudv2g.execute-api.us-west-2.amazonaws.com/v1/events",
    )
    assert.equal(sentRequests[0].init.method, "POST")
    assert.equal(sentRequests[0].init.headers.authorization, "Bearer orlune_test_key")

    const payload = JSON.parse(sentRequests[0].init.body)

    assert.equal(payload.event.provider, "OPENAI")
    assert.equal(payload.event.apiFamily, "OPENAI_RESPONSES")
    assert.equal(payload.event.customerId, "customer_123")
    assert.equal(payload.event.feature, "Suggestions generation")
    assert.equal(payload.event.eventType, "MODEL_CALL")
    assert.equal(payload.event.status, "SUCCEEDED")
    assert.equal(payload.event.model, "gpt-4.1-mini")
    assert.equal(payload.event.providerEvent.openai.finishReason, "stop")
    assert.deepEqual(payload.event.providerEvent.openai.usage, {
      input_tokens: 120,
      output_tokens: 45,
      total_tokens: 165,
    })
    assert.equal(typeof payload.event.operation.id, "string")
    assert.equal(payload.event.operation.type, "Suggestions generation")
    assert.equal(payload.event.operation.status, "SUCCEEDED")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("wrapping the same OpenAI client twice is idempotent", async () => {
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
    const openaiClient = {
      responses: {
        async create(input) {
          assert.equal("orlune_metadata" in input, false)

          return {
            _request_id: "req_provider_idempotent_123",
            id: "resp_idempotent_123",
            model: "gpt-4.1-mini",
            output: [
              {
                finish_reason: "stop",
              },
            ],
            usage: {
              input_tokens: 12,
              output_tokens: 6,
              total_tokens: 18,
            },
          }
        },
      },
    }

    const orlune = OrluneClient({
      apiKey: "orlune_test_key",
      environment: "production",
      telemetryDelivery: {
        mode: "sync",
      },
    })

    const firstWrappedClient = orlune.wrap(openaiClient, {
      defaults: {
        feature: "Suggestions generation",
      },
    })
    const secondWrappedClient = orlune.wrap(firstWrappedClient, {
      defaults: {
        feature: "Should not wrap twice",
      },
    })

    assert.equal(secondWrappedClient, firstWrappedClient)

    await secondWrappedClient.responses.create({
      model: "gpt-4.1-mini",
      input: "Hello",
      orlune_metadata: {
        customerId: "customer_idempotent_123",
        eventType: "MODEL_CALL",
      },
    })

    assert.equal(sentRequests.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("wrapped OpenAI responses.create rethrows provider error after sending failure telemetry", async () => {
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
    const providerError = Object.assign(new Error("rate limited"), {
      status: 429,
      code: "RATE_LIMITED",
      request_id: "req_provider_failed_123",
    })

    const openaiClient = {
      responses: {
        async create(input) {
          assert.equal("orlune_metadata" in input, false)
          throw providerError
        },
      },
    }

    const orlune = OrluneClient({
      apiKey: "orlune_test_key",
      environment: "production",
      telemetryDelivery: {
        mode: "sync",
      },
    })

    const wrappedClient = orlune.wrap(openaiClient, {
      defaults: {
        feature: "Research mode",
      },
    })

    await assert.rejects(
      () =>
        wrappedClient.responses.create({
          model: "gpt-4.1-mini",
          input: "Hello",
          orlune_metadata: {
            customerId: "customer_456",
            eventType: "MODEL_CALL",
            activity: {
              id: "activity_fixed_123",
              type: "answer_research_query",
              name: "Answer research query",
            },
          },
        }),
      providerError,
    )

    assert.equal(sentRequests.length, 1)

    const payload = JSON.parse(sentRequests[0].init.body)

    assert.equal(payload.event.status, "RATE_LIMITED")
    assert.equal(payload.event.errorCode, "RATE_LIMITED")
    assert.equal(payload.event.requestId, "req_provider_failed_123")
    assert.equal(payload.event.operation.id, "activity_fixed_123")
    assert.equal(payload.event.operation.type, "answer_research_query")
    assert.equal(payload.event.operation.name, "Answer research query")
    assert.equal(payload.event.operation.status, "FAILED")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("wrapped OpenAI responses.create skips telemetry and warns when eventType is missing", async () => {
  const sentRequests = []
  const warnings = []
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn

  globalThis.fetch = async (url, init) => {
    sentRequests.push({ url, init })

    return {
      ok: true,
      status: 200,
    }
  }

  console.warn = (message) => {
    warnings.push(String(message))
  }

  try {
    const openaiClient = {
      responses: {
        async create(input) {
          assert.equal("orlune_metadata" in input, false)

          return {
            _request_id: "req_provider_789",
            id: "resp_789",
            model: "gpt-4.1-mini",
            output: [
              {
                finish_reason: "stop",
              },
            ],
            usage: {
              input_tokens: 40,
              output_tokens: 10,
              total_tokens: 50,
            },
          }
        },
      },
    }

    const orlune = OrluneClient({
      apiKey: "orlune_test_key",
      environment: "production",
      telemetryDelivery: {
        mode: "sync",
      },
    })

    const wrappedClient = orlune.wrap(openaiClient, {
      defaults: {
        feature: "Suggestions generation",
      },
    })

    const result = await wrappedClient.responses.create({
      model: "gpt-4.1-mini",
      input: "Hello",
      orlune_metadata: {
        customerId: "customer_123",
      },
    })

    assert.equal(result.model, "gpt-4.1-mini")
    assert.equal(sentRequests.length, 0)
    assert.deepEqual(warnings, [
      "[orlune] Skipping OpenAI telemetry because eventType is missing.",
    ])
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
  }
})

test("wrapped OpenAI chat.completions.create sends one terminal telemetry event for streamed success", async () => {
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
    const openaiClient = {
      chat: {
        completions: {
          create(input) {
            assert.equal("orlune_metadata" in input, false)
            assert.equal(input.stream, true)
            assert.equal(input.stream_options.include_usage, true)

            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  id: "chatcmpl_stream_123",
                  model: "gpt-4.1-mini",
                  choices: [
                    {
                      delta: { content: "Hello" },
                      finish_reason: null,
                    },
                  ],
                }
                yield {
                  id: "chatcmpl_stream_123",
                  model: "gpt-4.1-mini",
                  choices: [
                    {
                      delta: {},
                      finish_reason: "stop",
                    },
                  ],
                  usage: {
                    prompt_tokens: 100,
                    completion_tokens: 30,
                    total_tokens: 130,
                  },
                }
              },
            }
          },
        },
      },
    }

    const orlune = OrluneClient({
      apiKey: "orlune_test_key",
      environment: "production",
      telemetryDelivery: {
        mode: "sync",
      },
    })

    const wrappedClient = orlune.wrap(openaiClient, {
      defaults: {
        feature: "Chat assistant",
      },
    })

    const stream = await wrappedClient.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      orlune_metadata: {
        customerId: "customer_stream_123",
        eventType: "CHAT_STREAM",
      },
    })

    const chunks = []

    for await (const chunk of stream) {
      chunks.push(chunk)
    }

    assert.equal(chunks.length, 2)
    assert.equal(sentRequests.length, 1)

    const payload = JSON.parse(sentRequests[0].init.body)

    assert.equal(payload.event.apiFamily, "OPENAI_CHAT_COMPLETIONS")
    assert.equal(payload.event.captureType, "STREAM_FINAL")
    assert.equal(payload.event.status, "SUCCEEDED")
    assert.equal(payload.event.requestId, "chatcmpl_stream_123")
    assert.equal(payload.event.providerEvent.openai.finishReason, "stop")
    assert.deepEqual(payload.event.providerEvent.openai.usage, {
      prompt_tokens: 100,
      completion_tokens: 30,
      total_tokens: 130,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("wrapped OpenAI responses.create sends one terminal telemetry event for streamed success", async () => {
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
    const openaiClient = {
      responses: {
        create(input) {
          assert.equal("orlune_metadata" in input, false)
          assert.equal(input.stream, true)

          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "response.output_text.delta",
                delta: "Hello",
              }
              yield {
                type: "response.completed",
                response: {
                  _request_id: "req_response_stream_123",
                  id: "resp_stream_123",
                  model: "gpt-4.1-mini",
                  output: [
                    {
                      finish_reason: "stop",
                    },
                  ],
                  usage: {
                    input_tokens: 80,
                    output_tokens: 20,
                    total_tokens: 100,
                  },
                },
              }
            },
          }
        },
      },
    }

    const orlune = OrluneClient({
      apiKey: "orlune_test_key",
      environment: "production",
      telemetryDelivery: {
        mode: "sync",
      },
    })

    const wrappedClient = orlune.wrap(openaiClient, {
      defaults: {
        feature: "Suggestions generation",
      },
    })

    const stream = await wrappedClient.responses.create({
      model: "gpt-4.1-mini",
      input: "Hello",
      stream: true,
      orlune_metadata: {
        customerId: "customer_response_stream_123",
        eventType: "RESPONSE_STREAM",
      },
    })

    const events = []

    for await (const event of stream) {
      events.push(event)
    }

    assert.equal(events.length, 2)
    assert.equal(sentRequests.length, 1)

    const payload = JSON.parse(sentRequests[0].init.body)

    assert.equal(payload.event.apiFamily, "OPENAI_RESPONSES")
    assert.equal(payload.event.captureType, "STREAM_FINAL")
    assert.equal(payload.event.status, "SUCCEEDED")
    assert.equal(payload.event.requestId, "req_response_stream_123")
    assert.equal(payload.event.providerEvent.openai.finishReason, "stop")
    assert.deepEqual(payload.event.providerEvent.openai.usage, {
      input_tokens: 80,
      output_tokens: 20,
      total_tokens: 100,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("wrapped OpenAI streamed call sends canceled terminal telemetry when consumer stops early", async () => {
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
    const openaiClient = {
      chat: {
        completions: {
          create() {
            return {
              async *[Symbol.asyncIterator]() {
                yield {
                  id: "chatcmpl_stream_cancel_123",
                  model: "gpt-4.1-mini",
                  choices: [
                    {
                      delta: { content: "Hello" },
                      finish_reason: null,
                    },
                  ],
                }
                yield {
                  id: "chatcmpl_stream_cancel_123",
                  model: "gpt-4.1-mini",
                  choices: [
                    {
                      delta: { content: "World" },
                      finish_reason: null,
                    },
                  ],
                }
              },
            }
          },
        },
      },
    }

    const orlune = OrluneClient({
      apiKey: "orlune_test_key",
      environment: "production",
      telemetryDelivery: {
        mode: "sync",
      },
    })

    const wrappedClient = orlune.wrap(openaiClient, {
      defaults: {
        feature: "Chat assistant",
      },
    })

    const stream = await wrappedClient.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      orlune_metadata: {
        customerId: "customer_stream_cancel_123",
        eventType: "CHAT_STREAM",
      },
    })

    for await (const _chunk of stream) {
      break
    }

    assert.equal(sentRequests.length, 1)

    const payload = JSON.parse(sentRequests[0].init.body)

    assert.equal(payload.event.captureType, "STREAM_FINAL")
    assert.equal(payload.event.status, "CANCELED")
  } finally {
    globalThis.fetch = originalFetch
  }
})
