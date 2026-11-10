import test from "node:test"
import assert from "node:assert/strict"
import OpenAI from "openai"
import { OrluneClient, OrluneGuardrailException } from "../dist/index.js"

const metadata = { customerId: "customer", feature: "test", eventType: "MODEL_CALL" }

function setup(t, { api, stream = false, block = false, fail = false } = {}) {
  let calls = 0
  let checks = 0
  const events = []
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/evaluate")) {
      checks++
      return Response.json({ evaluationId: "eval_1", evaluatedAt: new Date().toISOString(),
        decision: block ? "BLOCK" : "ALLOW", reasonCode: block ? "LIMIT_EXCEEDED" : "NO_MATCH",
        matchedRule: block ? { id: "rule", name: "Limit", message: "Blocked" } : null })
    }
    events.push(JSON.parse(init.body).event)
    return Response.json({})
  })
  const value = { id: "provider_id", object: api === "responses" ? "response" : "chat.completion",
    status: "completed", model: "gpt-4.1", service_tier: "default", output: [], choices: [],
    usage: api === "responses" ? { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      : { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
  const provider = new OpenAI({ apiKey: "fake", maxRetries: 0, fetch: async (_url, init) => {
    calls++
    assert.equal(checks, 1)
    const body = JSON.parse(init.body)
    assert.equal("orlune_metadata" in body, false)
    if (fail) return Response.json({ error: { message: "Invalid key", type: "authentication_error", code: "invalid_api_key" } }, { status: 401 })
    if (stream) {
      const chunks = api === "responses" ? [{ type: "response.completed", response: value }]
        : [{ ...value, usage: null, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, { ...value, choices: [] }]
      return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream", "x-request-id": "req_1" } })
    }
    return Response.json(value, { headers: { "x-request-id": "req_1" } })
  } })
  const client = OrluneClient({ apiKey: "fake", environment: "sandbox" }).wrap(provider, { guardrails: { enabled: true } })
  const input = { model: "gpt-4.1", stream, orlune_metadata: metadata,
    ...(api === "responses" ? { input: "Hello" } : { messages: [{ role: "user", content: "Hello" }] }) }
  const call = () => api === "responses" ? client.responses.create(input) : client.chat.completions.create(input)
  return { call, client, input, events, calls: () => calls, checks: () => checks }
}

for (const api of ["responses", "chat"]) {
  test(`${api}: native tee branches retain helpers and share one telemetry event`, async t => {
    const state = setup(t, { api, stream: true })
    const stream = await state.call()
    const [left, right] = stream.tee()
    assert.equal(left.controller, stream.controller)
    assert.equal(right.controller, stream.controller)
    const leftEvents = []
    for await (const event of left) leftEvents.push(event)
    // Consume the second branch later, through another native stream helper.
    const lines = await new Response(right.toReadableStream()).text()
    assert.deepEqual(lines.trim().split("\n").map(JSON.parse), leftEvents)
    assert.equal(state.events.length, 1)
    assert.equal(state.events[0].status, "SUCCEEDED")
    assert.equal(state.calls(), 1)
    assert.equal(state.checks(), 1)
  })

  test(`${api}: nested native tee supports concurrent readers without duplicate telemetry`, async t => {
    const state = setup(t, { api, stream: true })
    const [left, right] = (await state.call()).tee()
    const [first, second] = left.tee()
    const consume = async stream => { const events = []; for await (const event of stream) events.push(event); return events }
    const results = await Promise.all([first, second, right].map(consume))
    assert.deepEqual(results[0], results[1])
    assert.deepEqual(results[0], results[2])
    assert.equal(state.events.length, 1)
    assert.equal(state.events[0].status, "SUCCEEDED")
  })

  test(`${api}: leaving one tee branch early does not cancel the other`, async t => {
    const state = setup(t, { api, stream: true })
    const stream = await state.call()
    const [left, right] = stream.tee()
    for await (const _event of left) break
    assert.equal(stream.controller.signal.aborted, false)
    assert.equal(state.events.length, 0)
    for await (const _event of right) { /* finish the shared source */ }
    assert.equal(state.events.length, 1)
    assert.equal(state.events[0].status, "SUCCEEDED")
  })

  test(`${api}: native parse helper remains compatible`, async t => {
    const state = setup(t, { api })
    const pending = api === "responses" ? state.client.responses.parse(state.input) : state.client.chat.completions.parse(state.input)
    const result = await pending.withResponse()
    assert.equal(result.data.id, "provider_id")
    assert.equal(result.request_id, "req_1")
    assert.equal(state.calls(), 1)
    assert.equal(state.events.length, 1)
  })

  test(`${api}: ordinary promise chaining preserves results and runs cleanup`, async t => {
    const state = setup(t, { api })
    let cleanups = 0
    const result = await state.call().then(value => value.id).finally(() => cleanups++)
    assert.equal(result, "provider_id")
    assert.equal(cleanups, 1)
    assert.equal(state.events.length, 1)
  })

  for (const stream of [false, true]) {
    test(`${api} stream=${stream}: await and helpers share one invocation and telemetry`, async t => {
      const state = setup(t, { api, stream })
      const pending = state.call()
      const [result, envelope, raw] = await Promise.all([pending, pending.withResponse(), pending.asResponse()])
      assert.equal(result, envelope.data)
      assert.equal(raw, envelope.response)
      assert.equal(envelope.request_id, "req_1")
      if (stream) for await (const _event of result) { /* consume once */ }
      assert.equal(state.calls(), 1)
      assert.equal(state.checks(), 1)
      assert.equal(state.events.length, 1)
      assert.equal(state.events[0].status, "SUCCEEDED")
      assert.equal(await pending, result)
      assert.equal(state.events.length, 1)
    })
  }

  test(`${api}: asResponse leaves the raw body unread and does not emit success telemetry`, async t => {
    const state = setup(t, { api })
    const raw = await state.call().asResponse()
    assert.equal(raw.bodyUsed, false)
    assert.equal((await raw.json()).id, "provider_id")
    assert.equal(state.events.length, 0)
    assert.equal(state.calls(), 1)
    assert.equal(state.checks(), 1)
  })

  test(`${api}: guardrail block prevents every consumption path`, async t => {
    const state = setup(t, { api, block: true })
    const pending = state.call()
    const results = await Promise.allSettled([pending, pending.withResponse(), pending.asResponse()])
    for (const result of results) {
      assert.equal(result.status, "rejected")
      assert.ok(result.reason instanceof OrluneGuardrailException)
    }
    assert.equal(state.calls(), 0)
    assert.equal(state.checks(), 1)
    assert.equal(state.events.length, 0)
  })

  test(`${api}: provider error is shared and reported once`, async t => {
    const state = setup(t, { api, fail: true })
    const pending = state.call()
    const results = await Promise.allSettled([pending, pending.withResponse(), pending.asResponse()])
    for (const result of results) {
      assert.equal(result.status, "rejected")
      assert.equal(result.reason.status, 401)
    }
    assert.equal(state.calls(), 1)
    assert.equal(state.events.length, 1)
    assert.equal(state.events[0].status, "FAILED")
  })
}
