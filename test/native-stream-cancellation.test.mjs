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
        metadata: { customerId: "test", feature: "test", eventType: "MODEL_CALL" },
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
