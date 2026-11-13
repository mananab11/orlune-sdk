import test from "node:test"
import assert from "node:assert/strict"
import { Stream } from "openai/core/streaming"
import { wrapOpenAIStreamResult } from "../dist/providers/openai/wrap-openai-stream-result.js"

for (const apiFamily of ["OPENAI_CHAT_COMPLETIONS", "OPENAI_RESPONSES"]) {
  for (const afterCompletion of [false, true]) {
    test(`${apiFamily}: native controller abort ${afterCompletion ? "after completion keeps success" : "before completion records cancellation"}`, async () => {
      const controller = new AbortController()
      const events = []
      const response = { id: "resp_test", model: "gpt-4.1", service_tier: "default", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }
      const chunk = apiFamily === "OPENAI_RESPONSES"
        ? afterCompletion ? { type: "response.completed", response } : { type: "response.created", response: { ...response, usage: null } }
        : { id: "chatcmpl_test", model: "gpt-4.1", service_tier: "default",
          choices: afterCompletion ? [] : [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
          usage: afterCompletion ? { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } : null }
      const native = Stream.fromSSEResponse(new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`), controller)
      const wrapped = wrapOpenAIStreamResult(native, {
        apiFamily, input: { model: "gpt-4.1", stream: true },
        metadata: { customerId: "test", feature: "test", eventType: "MODEL_CALL", activity: { id: "activity", type: "test" } },
        startedAt: new Date().toISOString(),
        telemetryDispatcher: { dispatch: async event => events.push(event.event), flush: async () => {} },
      })
      assert.equal(wrapped, native)
      const iterator = wrapped[Symbol.asyncIterator]()
      assert.equal((await iterator.next()).done, false)
      controller.abort()
      assert.equal((await iterator.next()).done, true)
      await iterator.return()
      assert.equal(events.length, 1)
      assert.equal(events[0].status, afterCompletion ? "SUCCEEDED" : "CANCELED")
      if (afterCompletion) assert.equal(events[0].providerEvent.openai.usage.total_tokens, 3)
    })
  }
}

for (const apiFamily of ["OPENAI_CHAT_COMPLETIONS", "OPENAI_RESPONSES"]) {
  for (const position of ["before-wrap", "before-read", "between-reads", "after-completion"]) {
    test(`${apiFamily}: abort ${position} records without another iterator operation`, async () => {
      const controller = new AbortController()
      const events = []
      const complete = position === "after-completion"
      const response = { id: "response", model: "model", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }
      const chunk = apiFamily === "OPENAI_RESPONSES"
        ? { type: complete ? "response.completed" : "response.created", response }
        : { id: "chat", model: "model", choices: complete ? [] : [{ index: 0, delta: {}, finish_reason: null }],
          ...(complete ? { usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } } : {}) }
      const native = Stream.fromSSEResponse(new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`), controller)
      if (position === "before-wrap") controller.abort()
      const wrapped = wrapOpenAIStreamResult(native, {
        apiFamily, input: { model: "model", stream: true },
        metadata: { customerId: "customer", eventType: "TEST", feature: "test", activity: { id: "activity", type: "test" } },
        startedAt: new Date().toISOString(),
        telemetryDispatcher: { dispatch: async event => events.push(event.event), flush: async () => {} },
      })
      const iterator = wrapped[Symbol.asyncIterator]()
      if (position === "between-reads" || complete) await iterator.next()
      controller.abort()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(events.length, 1)
      assert.equal(events[0].status, complete ? "SUCCEEDED" : "CANCELED")
      if (complete) assert.equal(events[0].providerEvent.openai.usage.total_tokens, 3)
      await iterator.return()
      controller.abort()
      assert.equal(events.length, 1)
    })
  }
}

test("abort during a pending read does not overwrite the provider's real exception", async () => {
  const controller = new AbortController()
  const events = []
  const failure = new Error("Provider disconnected")
  const native = new Stream(async function* () {
    await Promise.resolve()
    controller.abort()
    throw failure
  }, controller)
  const wrapped = wrapOpenAIStreamResult(native, {
    apiFamily: "OPENAI_RESPONSES", input: { model: "model", stream: true },
    metadata: { customerId: "customer", eventType: "TEST", feature: "test", activity: { id: "activity", type: "test" } },
    startedAt: new Date().toISOString(),
    telemetryDispatcher: { dispatch: async event => events.push(event.event), flush: async () => {} },
  })
  await assert.rejects(wrapped[Symbol.asyncIterator]().next(), error => error === failure)
  assert.equal(events.length, 1)
  assert.equal(events[0].status, "FAILED")
})

test("abort while reading still preserves a terminal response returned by that read", async () => {
  const controller = new AbortController()
  const events = []
  const native = new Stream(async function* () {
    controller.abort()
    yield { type: "response.completed", response: { id: "request", model: "model", usage: { input_tokens: 2, output_tokens: 1 } } }
  }, controller)
  const wrapped = wrapOpenAIStreamResult(native, {
    apiFamily: "OPENAI_RESPONSES", input: { model: "model", stream: true },
    metadata: { customerId: "customer", eventType: "TEST", feature: "test", activity: { id: "activity", type: "test" } },
    startedAt: new Date().toISOString(),
    telemetryDispatcher: { dispatch: async event => events.push(event.event), flush: async () => {} },
  })
  const iterator = wrapped[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value.type, "response.completed")
  assert.equal(events.length, 1)
  assert.equal(events[0].status, "SUCCEEDED")
  await iterator.return()
  assert.equal(events.length, 1)
})
