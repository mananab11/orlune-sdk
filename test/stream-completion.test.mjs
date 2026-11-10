import test from "node:test"
import assert from "node:assert/strict"
import { wrapOpenAIStreamResult } from "../dist/providers/openai/wrap-openai-stream-result.js"

async function capture(chunks, apiFamily, { stopEarly = false, n = 1 } = {}) {
  const events = []
  const source = { async *[Symbol.asyncIterator]() { yield* chunks } }
  const stream = wrapOpenAIStreamResult(source, {
    apiFamily, input: { model: "gpt-4.1", n },
    metadata: { customerId: "customer", feature: "test", eventType: "MODEL_CALL" },
    startedAt: new Date().toISOString(),
    telemetryDispatcher: { async dispatch(request) { events.push(request.event) } },
  })
  for await (const _chunk of stream) { if (stopEarly) break }
  assert.equal(events.length, 1)
  return events[0]
}

for (const type of ["response.incomplete", "response.failed"]) {
  for (const stopEarly of [false, true]) {
    test(`${type} preserves terminal evidence on ${stopEarly ? "break" : "exhaustion"}`, async () => {
      const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
      const event = await capture([{ type, response: {
        id: "resp_terminal", model: "gpt-4.1", service_tier: "priority", usage,
        incomplete_details: { reason: "max_output_tokens" },
        error: type === "response.failed" ? { code: "server_error" } : null,
      } }], "OPENAI_RESPONSES", { stopEarly })
      assert.equal(event.status, "FAILED")
      assert.equal(event.requestId, "resp_terminal")
      assert.equal(event.errorCode, type === "response.failed" ? "server_error" : "max_output_tokens")
      assert.deepEqual(event.providerEvent.openai.usage, usage)
      assert.equal(event.providerEvent.openai.serviceTier, "priority")
    })
  }
}

for (const n of [1, 2]) {
  test(`chat exhaustion requires all ${n} choices to finish`, async () => {
    const chunk = { id: "chat_id", model: "gpt-4.1", choices: [
      { index: 0, finish_reason: n === 1 ? null : "stop" },
    ] }
    const event = await capture([chunk], "OPENAI_CHAT_COMPLETIONS", { n })
    assert.equal(event.status, "FAILED")
    assert.equal(event.errorCode, "STREAM_INCOMPLETE")
  })
}

test("chat finished choices without usage remain successful with unavailable usage", async () => {
  const event = await capture([{ id: "chat_id", model: "gpt-4.1", choices: [
    { index: 0, finish_reason: "stop" }, { index: 1, finish_reason: "length" },
  ] }], "OPENAI_CHAT_COMPLETIONS", { n: 2 })
  assert.equal(event.status, "SUCCEEDED")
  assert.deepEqual(event.providerEvent.openai.usage, {})
})

for (const apiFamily of ["OPENAI_RESPONSES", "OPENAI_CHAT_COMPLETIONS"]) {
  const responses = apiFamily === "OPENAI_RESPONSES"
  const usage = responses
    ? { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
    : { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  const response = { id: "provider-id", model: "gpt-4.1", service_tier: "default", usage }
  const chunks = responses
    ? [{ type: "response.output_text.delta", delta: "Hello" }, { type: "response.completed", response }]
    : [{ ...response, usage: null, choices: [{ index: 0, finish_reason: "stop" }] },
        { ...response, choices: [] }]

  function setup({ cleanupError, nextError } = {}) {
    const events = []
    let reads = 0
    let closes = 0
    const source = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const index = reads++
            if (index < chunks.length) return { done: false, value: chunks[index] }
            if (nextError) throw nextError
            return { done: true }
          },
          async return(value) {
            closes++
            if (cleanupError) throw cleanupError
            return { done: true, value }
          },
        }
      },
    }
    const stream = wrapOpenAIStreamResult(source, {
      apiFamily,
      input: { model: "gpt-4.1", stream: true },
      metadata: { customerId: "customer", feature: "test", eventType: "MODEL_CALL" },
      startedAt: new Date().toISOString(),
      telemetryDispatcher: { async dispatch(request) { events.push(request.event) } },
    })
    return { stream, events, reads: () => reads, closes: () => closes }
  }

  function assertSuccess(events) {
    assert.equal(events.length, 1)
    assert.equal(events[0].status, "SUCCEEDED")
    assert.equal(events[0].requestId, "provider-id")
    assert.deepEqual(events[0].providerEvent.openai.usage, usage)
  }

  test(`${apiFamily}: breaking after terminal chunk preserves usage without draining`, async () => {
    const state = setup()
    for await (const chunk of state.stream) {
      if (chunk === chunks[1]) break
    }
    assert.equal(state.reads(), 2)
    assert.equal(state.closes(), 1)
    assertSuccess(state.events)
  })

  test(`${apiFamily}: early break remains canceled`, async () => {
    const state = setup()
    for await (const _chunk of state.stream) break
    assert.equal(state.reads(), 1)
    assert.equal(state.closes(), 1)
    assert.equal(state.events.length, 1)
    assert.equal(state.events[0].status, "CANCELED")
  })

  test(`${apiFamily}: repeated closure emits once and preserves return value`, async () => {
    const state = setup()
    const iterator = state.stream[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    assert.deepEqual(await iterator.return("closed"), { done: true, value: "closed" })
    await iterator.return()
    assertSuccess(state.events)
  })

  for (const phase of ["cleanupError", "nextError"]) {
    test(`${apiFamily}: ${phase} after completion preserves telemetry and rethrows`, async () => {
      const error = new Error("provider iterator failed")
      const state = setup({ [phase]: error })
      const iterator = state.stream[Symbol.asyncIterator]()
      await iterator.next()
      await iterator.next()
      await assert.rejects(phase === "cleanupError" ? iterator.return() : iterator.next(),
        caught => caught === error)
      assertSuccess(state.events)
    })
  }
}
