import test from "node:test"
import assert from "node:assert/strict"
import OpenAI from "openai"
import * as publicSdk from "../dist/index.js"
import { createTelemetryDispatcher } from "../dist/internal/telemetry-dispatcher.js"
import { buildOpenAIUsageEventFromFailure } from "../dist/providers/openai/build-openai-usage-event.js"

const sdk = () => publicSdk.OrluneClient({ apiKey: "test", baseURL: "https://test.invalid" })
const provider = () => new OpenAI({ apiKey: "test" })

test("repeated wraps preserve ownership and reject configuration changes at setup", () => {
  const first = sdk()
  const client = provider()
  const settings = { defaults: { feature: "original" } }
  assert.equal(first.wrap(client, settings), client)
  assert.equal(first.wrap(client), client)
  assert.equal(first.wrap(client, { defaults: { feature: "original" } }), client)
  assert.throws(() => sdk().wrap(client), /another Orlune client/)
  assert.throws(() => first.wrap(client, { defaults: { feature: "other" } }), /different settings/)
  settings.defaults.feature = "changed"
  assert.throws(() => first.wrap(client, settings), /different settings/)
})

test("wrap settings are snapshotted rather than following caller mutations", async t => {
  const events = []
  t.mock.method(globalThis, "fetch", async (_url, init) => { events.push(JSON.parse(init.body).event); return Response.json({}) })
  const settings = { defaults: { feature: "original" } }
  const client = sdk().wrap({ baseURL: "https://api.openai.com/v1", responses: { async create() {
    return { id: "test", model: "gpt-4.1", usage: {} }
  } } }, settings)
  settings.defaults.feature = "changed"
  await client.responses.create({ orlune_metadata: { customerId: "test", eventType: "MODEL_CALL", activity: { id: "activity", type: "original" } } })
  assert.equal(events.length, 1)
  assert.equal(events[0].feature, "original")
  assert.equal(events[0].operation.type, "original")
})

test("compatible methods alone and non-OpenAI endpoints are not identified as OpenAI", () => {
  const client = sdk()
  for (const baseURL of [undefined, "https://api.other-provider.com/v1", "https://api.openai.com.example.com/v1", "http://api.openai.com/v1", "invalid"]) {
    const raw = { baseURL, chat: { completions: { create() {} } } }
    const create = raw.chat.completions.create
    assert.throws(() => client.wrap(raw), /Unsupported provider/)
    assert.equal(raw.chat.completions.create, create)
  }
  assert.equal(client.wrap(provider()).baseURL, "https://api.openai.com/v1")
})

test("invalid queue settings fail immediately; zero retries remains supported", () => {
  for (const field of ["maxQueueSize", "flushIntervalMs", "maxRetries"]) {
    const invalid = [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "5"]
    if (field !== "maxRetries") invalid.push(0)
    if (field === "flushIntervalMs") invalid.push(2147483648)
    for (const value of invalid) {
      assert.throws(() => publicSdk.OrluneClient({ apiKey: "test", baseURL: "https://test.invalid", telemetryDelivery: { mode: "background_flush", [field]: value } }), new RegExp(field))
    }
  }
  assert.doesNotThrow(() => publicSdk.OrluneClient({ apiKey: "test", baseURL: "https://test.invalid", telemetryDelivery: { mode: "background_flush", maxRetries: 0, maxQueueSize: 1, flushIntervalMs: 1 } }))
})

test("dispatcher absorbs sync and background transport failures and only logs", async t => {
  const log = t.mock.method(console, "error", () => {})
  for (const mode of ["sync", "background_flush"]) {
    let calls = 0
    const dispatcher = createTelemetryDispatcher({ telemetryDelivery: { mode, maxRetries: 0, flushIntervalMs: 60000 },
      transport: { async send() { calls++; throw new Error("private payload") } } })
    await dispatcher.dispatch({ event: { requestId: "test" } })
    await dispatcher.flush()
    assert.equal(calls, 1)
  }
  assert.equal(log.mock.callCount(), 2)
  assert.doesNotMatch(JSON.stringify(log.mock.calls.map(call => call.arguments)), /private payload/)
})

test("failure telemetry uses native requestID, preserves aliases, and only then generates an ID", () => {
  const params = { apiFamily: "OPENAI_RESPONSES", input: { model: "gpt-4.1" }, metadata: { customerId: "test", feature: "test", eventType: "MODEL_CALL", activity: { id: "activity", type: "test" } }, startedAt: "2026-11-06T00:00:00Z", completedAt: "2026-11-06T00:00:01Z" }
  const error = new OpenAI.AuthenticationError(401, {}, "Unauthorized", new Headers({ "x-request-id": "req_native" }))
  error.request_id = "req_alias"
  assert.equal(buildOpenAIUsageEventFromFailure(params, error).event.event.requestId, "req_native")
  for (const key of ["request_id", "requestId"]) {
    assert.equal(buildOpenAIUsageEventFromFailure(params, { [key]: "req_alias" }).event.event.requestId, "req_alias")
  }
  assert.match(buildOpenAIUsageEventFromFailure(params, new Error("failure")).event.event.requestId, /^orlune_req_/)
})

test("public runtime exports expose the client, exceptions and configuration constants", () => {
  assert.deepEqual(Object.keys(publicSdk).sort(), ["GuardrailErrorMode", "OrluneClient", "OrluneEvaluationException", "OrluneGuardrailException", "TelemetryMode"])
})
