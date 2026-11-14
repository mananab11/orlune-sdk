import test from "node:test"
import assert from "node:assert/strict"
import Anthropic from "@anthropic-ai/sdk"
import { OrluneClient, OrluneGuardrailException, OrluneEvaluationException } from "../dist/index.js"
import { extractAnthropicPrompt } from "../dist/providers/anthropic/extract-prompt.js"
import { preserveGuardrailErrors } from "../dist/providers/anthropic/preserve-guardrail-errors.js"

const metadata = { customerId: "customer", feature: "support", eventType: "REPLY", activity: { id: "activity", type: "support" } }

for (const guarded of [false, true]) {
  test(`Anthropic native stream validates metadata before network calls (guarded=${guarded})`, async t => {
    const s = setup(t, { guarded })
    for (const [invalid, field] of [
      [undefined, "activity.type"],
      [{ ...metadata, customerId: undefined }, "customerId"],
      [{ ...metadata, eventType: undefined }, "eventType"],
      [{ ...metadata, activity: { type: "support" } }, "activity.id"],
      [{ ...metadata, activity: { id: "activity" } }, "activity.type"],
    ]) {
      const stream = s.client.messages.stream({ ...s.input, orlune_metadata: invalid })
      await assert.rejects(stream.finalMessage(), error => error.message.includes(field))
    }
    assert.equal(s.calls(), 0)
    assert.equal(s.checks.length, 0)
    assert.equal(s.telemetry.length, 0)
  })
}

test("Anthropic native stream returns parsed structured output without Orlune projections", async t => {
  const s = setup(t, { guarded: false })
  const stream = s.client.messages.stream({ ...s.input, output_config: { format: {
    type: "json_schema", schema: { type: "object" }, parse: text => ({ answer: text }),
  } } })
  const result = await stream.finalMessage()
  assert.deepEqual(result.parsed_output, { answer: "Hello" })
  assert.equal(s.calls(), 1)
  assert.equal(s.telemetry.length, 1)
})
const usage = { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 200,
  cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
  output_tokens_details: { thinking_tokens: 10 }, service_tier: "standard" }
const message = { id: "msg_test", type: "message", model: "claude-haiku-4-5-20251001", role: "assistant",
  content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn", stop_sequence: null, usage }
const streamEvents = [
  { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 12 } },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 30, output_tokens_details: { thinking_tokens: 10 } } },
  { type: "message_stop" },
]

function setup(t, { block = false, fail = false, events = streamEvents, guarded = true, telemetryFails = false, evaluationFails = false,
  delivery = { mode: "sync" } } = {}) {
  let calls = 0
  const checks = [], telemetry = []
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/evaluate")) {
      checks.push(JSON.parse(init.body))
      if (evaluationFails) return Response.json({ message: "Unavailable" }, { status: 503 })
      return Response.json({ evaluationId: "eval_1", evaluatedAt: new Date().toISOString(),
        decision: block ? "BLOCK" : "ALLOW", reasonCode: block ? "PROMPT_INJECTION" : "NO_MATCH",
        matchedRule: block ? { id: "rule", name: "Safety", message: "Blocked by policy" } : null })
    }
    if (telemetryFails) throw new Error("Telemetry offline")
    telemetry.push(JSON.parse(init.body).event)
    return Response.json({})
  })
  const provider = new Anthropic({ apiKey: "fake", maxRetries: 0, fetch: async (_url, init) => {
    calls++
    if (guarded) assert.equal(checks.length, 1)
    const body = JSON.parse(init.body)
    assert.equal("orlune_metadata" in body, false)
    assert.equal(body.system, "Trusted instructions")
    if (fail) return Response.json({ type: "error", error: { type: "authentication_error", message: "Invalid key" } },
      { status: 401, headers: { "request-id": "req_error" } })
    if (body.stream) return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream", "request-id": "req_stream" } })
    return Response.json(message, { headers: { "request-id": "req_response" } })
  } })
  const sdk = OrluneClient({ apiKey: "fake", baseURL: "https://test.invalid", telemetryDelivery: delivery, guardrails: { enabled: guarded } })
  const client = sdk.wrap(provider)
  const input = { model: "claude-haiku-4-5", max_tokens: 100, system: "Trusted instructions",
    messages: [{ role: "user", content: "Hello" }], orlune_metadata: metadata }
  return { client, sdk, input, checks, telemetry, calls: () => calls }
}

for (const mode of ["response", "stream", "helper"]) {
  test(`Anthropic ${mode}: native result, one preflight and one telemetry event`, async t => {
    const s = setup(t)
    if (mode === "response") {
      const pending = s.client.messages.create(s.input)
      const [result, envelope] = await Promise.all([pending, pending.withResponse()])
      assert.equal(result, envelope.data)
      assert.equal(envelope.request_id, "req_response")
      assert.deepEqual(result.content, message.content)
      assert.equal(await pending, result)
    } else if (mode === "stream") {
      const pending = s.client.messages.create({ ...s.input, stream: true })
      const stream = await pending
      assert.equal((await pending.withResponse()).data, stream)
      const actual = []
      for await (const event of stream) actual.push(event)
      assert.deepEqual(actual, streamEvents)
    } else {
      const stream = s.client.messages.stream(s.input)
      let text = ""
      assert.equal(stream.on("text", delta => { text += delta }), stream)
      const [result, envelope, finalText] = await Promise.all([stream.finalMessage(), stream.withResponse(), stream.finalText()])
      assert.equal(envelope.data, stream)
      assert.deepEqual(result.content, message.content)
      assert.equal(text, "Hello")
      assert.equal(finalText, "Hello")
    }
    assert.equal(s.calls(), 1)
    assert.equal(s.checks.length, 1)
    assert.equal(s.checks[0].prompt, "Hello")
    assert.equal(s.telemetry.length, 1)
    assert.equal(s.telemetry[0].provider, "ANTHROPIC")
    assert.equal(s.telemetry[0].status, "SUCCEEDED")
    assert.deepEqual(s.telemetry[0].providerEvent.anthropic.usage, usage)
    assert.equal(s.telemetry[0].model, message.model)
    assert.equal(s.telemetry[0].operation.id, s.checks[0].activityId)
  })

  test(`Anthropic ${mode}: guardrail block prevents provider call and telemetry`, async t => {
    const s = setup(t, { block: true })
    if (mode === "helper") {
      const stream = s.client.messages.stream(s.input)
      let received
      const listener = () => assert.fail("removed listener ran")
      stream.on("error", listener).off("error", listener).on("error", error => { received = error })
      await assert.rejects(stream.finalMessage(), OrluneGuardrailException)
      assert.ok(received instanceof OrluneGuardrailException)
      await assert.rejects(stream.withResponse(), OrluneGuardrailException)
    } else {
      const pending = s.client.messages.create({ ...s.input, stream: mode === "stream" })
      await assert.rejects(Promise.resolve(pending), OrluneGuardrailException)
      await assert.rejects(pending.asResponse(), OrluneGuardrailException)
    }
    assert.equal(s.calls(), 0)
    assert.equal(s.telemetry.length, 0)
    assert.equal(s.checks.length, 1)
  })

  test(`Anthropic ${mode}: HTTP errors stay native and emit once`, async t => {
    const s = setup(t, { fail: true })
    const pending = mode === "helper" ? s.client.messages.stream(s.input).finalMessage()
      : Promise.resolve(s.client.messages.create({ ...s.input, stream: mode === "stream" }))
    await assert.rejects(pending, error => error instanceof Anthropic.AuthenticationError && error.status === 401)
    assert.equal(s.telemetry.length, 1)
    assert.equal(s.telemetry[0].status, "FAILED")
    assert.equal(s.telemetry[0].requestId, "req_error")
    assert.equal(s.telemetry[0].errorCode, "authentication_error")
    assert.deepEqual(s.telemetry[0].providerEvent.anthropic.usage, {})
  })
}

test("Anthropic native tee and readable helpers do not duplicate telemetry", async t => {
  const s = setup(t)
  const stream = await s.client.messages.create({ ...s.input, stream: true })
  const [left, right] = stream.tee()
  const leftValues = []
  for await (const event of left) leftValues.push(event)
  const rightValues = (await new Response(right.toReadableStream()).text()).trim().split("\n").map(JSON.parse)
  assert.deepEqual(leftValues, rightValues)
  assert.equal(s.telemetry.length, 1)
})

test("Anthropic raw response ownership is preserved", async t => {
  const s = setup(t)
  const raw = await s.client.messages.create(s.input).asResponse()
  assert.equal(raw.bodyUsed, false)
  assert.deepEqual(await raw.json(), message)
  assert.equal(s.telemetry.length, 0)
})

test("Anthropic interrupted streams do not report partial output as final usage", async t => {
  const s = setup(t)
  const stream = await s.client.messages.create({ ...s.input, stream: true })
  for await (const _event of stream) break
  assert.equal(s.telemetry.length, 1)
  assert.equal(s.telemetry[0].status, "CANCELED")
  assert.deepEqual(s.telemetry[0].providerEvent.anthropic.usage, {})
})

test("Anthropic abort before iteration still records cancellation", async t => {
  const s = setup(t)
  const stream = await s.client.messages.create({ ...s.input, stream: true })
  stream.controller.abort()
  // Abort notifications dispatch asynchronously in sync delivery mode.
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(s.telemetry.length, 1)
  assert.equal(s.telemetry[0].status, "CANCELED")
})

test("Anthropic SSE provider errors are not mislabeled as cancellation during native cleanup", async t => {
  const s = setup(t, { events: [...streamEvents.slice(0, 3),
    { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }] })
  const stream = await s.client.messages.create({ ...s.input, stream: true })
  await assert.rejects(async () => { for await (const _event of stream) { /* consume */ } }, Anthropic.APIError)
  assert.equal(s.telemetry.length, 1)
  assert.equal(s.telemetry[0].status, "FAILED")
  assert.equal(s.telemetry[0].errorCode, "overloaded_error")
})

test("Anthropic null usage deltas preserve reported cache counts", async t => {
  const events = structuredClone(streamEvents)
  events[5].usage.cache_creation_input_tokens = null
  events[5].usage.cache_read_input_tokens = null
  events[5].usage.input_tokens = null
  const s = setup(t, { events })
  await s.client.messages.stream(s.input).finalMessage()
  assert.deepEqual(s.telemetry[0].providerEvent.anthropic.usage, usage)
})

test("Anthropic final message_delta usage survives an early consumer break", async t => {
  const s = setup(t)
  const stream = await s.client.messages.create({ ...s.input, stream: true })
  for await (const event of stream) if (event.type === "message_delta" && event.delta.stop_reason) break
  assert.equal(s.telemetry.length, 1)
  assert.equal(s.telemetry[0].status, "SUCCEEDED")
  assert.deepEqual(s.telemetry[0].providerEvent.anthropic.usage, usage)
})

test("Anthropic helper async iteration preserves guardrail exceptions", async t => {
  const s = setup(t, { block: true })
  await assert.rejects(async () => {
    for await (const _event of s.client.messages.stream(s.input)) { /* consume */ }
  }, OrluneGuardrailException)
  assert.equal(s.calls(), 0)
})

for (const kind of ["block", "evaluation failure"]) {
  test(`Anthropic helper readable stream preserves Orlune ${kind} exceptions`, async t => {
    const s = setup(t, { block: kind === "block", evaluationFails: kind === "evaluation failure" })
    const stream = s.client.messages.stream(s.input)
    await assert.rejects(new Response(stream.toReadableStream()).text(),
      kind === "block" ? OrluneGuardrailException : OrluneEvaluationException)
    assert.equal(s.calls(), 0)
    assert.equal(s.checks.length, 1)
    assert.equal(s.telemetry.length, 0)
  })
}

test("Anthropic helper readable stream preserves native data and emits telemetry once", async t => {
  const s = setup(t)
  const stream = s.client.messages.stream(s.input)
  const text = await new Response(stream.toReadableStream()).text()
  assert.deepEqual(text.trim().split("\n").map(JSON.parse), streamEvents)
  assert.equal((await stream.finalMessage()).id, message.id)
  assert.equal(s.calls(), 1)
  assert.equal(s.checks.length, 1)
  assert.equal(s.telemetry.length, 1)
})

test("Anthropic helper readable stream keeps provider errors native", async t => {
  const s = setup(t, { fail: true })
  const stream = s.client.messages.stream(s.input)
  await assert.rejects(new Response(stream.toReadableStream()).text(), Anthropic.AuthenticationError)
  assert.equal(s.calls(), 1)
  assert.equal(s.telemetry.length, 1)
  assert.equal(s.telemetry[0].status, "FAILED")
})

test("Anthropic readable error adapter forwards cancellation and does not read ahead", async () => {
  let pulls = 0
  let cancelReason
  const native = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array([1, 2, 3])) },
    cancel(reason) { cancelReason = reason },
  }, { highWaterMark: 0 })
  const wrapped = preserveGuardrailErrors({ toReadableStream: () => native }).toReadableStream()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(pulls, 0)
  const reader = wrapped.getReader()
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2, 3]))
  assert.equal(pulls, 1)
  await reader.cancel("caller stopped")
  assert.equal(cancelReason, "caller stopped")
  assert.equal(native.locked, false)
})

test("Anthropic readable error adapter supports cancellation during a pending read", async () => {
  let canceled = false
  const native = new ReadableStream({ cancel() { canceled = true } })
  const wrapped = preserveGuardrailErrors({ toReadableStream: () => native }).toReadableStream()
  const reader = wrapped.getReader()
  const pending = reader.read()
  await Promise.resolve()
  await reader.cancel()
  assert.equal((await pending).done, true)
  assert.equal(canceled, true)
  assert.equal(native.locked, false)
})

test("Anthropic stopping on message_stop preserves completed usage", async t => {
  const s = setup(t)
  const stream = await s.client.messages.create({ ...s.input, stream: true })
  for await (const event of stream) if (event.type === "message_stop") break
  assert.equal(s.telemetry.length, 1)
  assert.equal(s.telemetry[0].status, "SUCCEEDED")
  assert.deepEqual(s.telemetry[0].providerEvent.anthropic.usage, usage)
})

test("Anthropic premature EOF is recorded without inventing a provider exception", async t => {
  const s = setup(t, { events: streamEvents.slice(0, 3) })
  for await (const _event of await s.client.messages.create({ ...s.input, stream: true })) { /* consume */ }
  assert.equal(s.telemetry[0].status, "FAILED")
  assert.equal(s.telemetry[0].errorCode, "STREAM_INCOMPLETE")
})

test("Anthropic telemetry delivery failure cannot fail a provider response", async t => {
  const s = setup(t, { telemetryFails: true })
  const result = await s.client.messages.create(s.input)
  assert.equal(result.id, message.id)
})

test("Anthropic queued usage is detached from the response", async t => {
  const s = setup(t, { delivery: { mode: "background_flush", flushIntervalMs: 60000 } })
  const result = await s.client.messages.create(s.input)
  result.usage.output_tokens = 999
  result.usage.output_tokens_details.thinking_tokens = 999
  await s.sdk.flush()
  assert.deepEqual(s.telemetry[0].providerEvent.anthropic.usage, usage)
})

test("Anthropic unguarded helper remains the native MessageStream", async t => {
  const s = setup(t, { guarded: false })
  assert.equal((await s.client.messages.stream(s.input).finalMessage()).id, message.id)
  assert.equal(s.checks.length, 0)
  assert.equal(s.telemetry.length, 1)
})

test("Anthropic prompt extraction excludes system, thinking and tool results", () => {
  assert.equal(extractAnthropicPrompt({ system: "secret", messages: [
    { role: "user", content: "old" }, { role: "assistant", content: "old assistant" },
    { role: "user", content: [{ type: "text", text: "new" }, { type: "tool_result", content: "private tool data" }] },
  ] }), "new")
  assert.equal(extractAnthropicPrompt({ messages: [{ role: "user", content: "old" },
    { role: "user", content: [{ type: "image", source: {} }] }] }), undefined)
})
