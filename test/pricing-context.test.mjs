import test from "node:test"
import assert from "node:assert/strict"
import { OrluneClient } from "../dist/index.js"

for (const api of ["responses", "chat"]) {
  for (const stream of [false, true]) {
    test(`${api} ${stream ? "stream" : "response"} captures actual tier without changing request`, async () => {
      const originalFetch = globalThis.fetch
      const events = []
      globalThis.fetch = async (_url, init) => {
        events.push(JSON.parse(init.body).event)
        return { ok: true, status: 200 }
      }
      try {
        const response = { id: "resp_1", model: "gpt-4.1", service_tier: "priority",
          usage: api === "responses" ? { input_tokens: 10, output_tokens: 5 } : { prompt_tokens: 10, completion_tokens: 5 } }
        const create = async input => {
          assert.equal(input.service_tier, "flex")
          assert.equal(input.tools[0].type, "web_search")
          if (!stream) return response
          return { async *[Symbol.asyncIterator]() {
            yield api === "responses" ? { type: "response.completed", response }
              : { ...response, usage: null, choices: [{ finish_reason: "stop" }] }
            // Usage may arrive separately from the tier in chat streaming.
            if (api === "chat") yield { id: response.id, usage: response.usage, choices: [] }
          } }
        }
        const client = OrluneClient({ apiKey: "test", baseURL: "https://test.invalid", telemetryDelivery: { mode: "sync" } })
          .wrap(api === "responses" ? { baseURL: "https://api.openai.com/v1", responses: { create } } : { baseURL: "https://api.openai.com/v1", chat: { completions: { create } } })
        const method = api === "responses" ? client.responses.create : client.chat.completions.create
        const result = await method({ model: "gpt-4.1", service_tier: "flex", tools: [{ type: "web_search" }], stream,
          orlune_metadata: { customerId: "customer", feature: "test", eventType: "MODEL_CALL", activity: { id: "activity", type: "test" } } })
        if (stream) for await (const _chunk of result) { /* consume to completion */ }
        assert.equal(events.length, 1)
        assert.equal(events[0].providerEvent.openai.serviceTier, "priority")
        assert.equal(events[0].providerEvent.openai.requestedServiceTier, "flex")
        assert.equal(events[0].providerEvent.openai.hasAdditionalCharges, true)
      } finally { globalThis.fetch = originalFetch }
    })
  }
}
