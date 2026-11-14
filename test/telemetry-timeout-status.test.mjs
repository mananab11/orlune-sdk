import test from "node:test"
import assert from "node:assert/strict"
import { OrluneClient } from "../dist/index.js"
import OpenAI from "openai"

const metadata = { customerId: "customer", feature: "test", eventType: "MODEL_CALL", activity: { id: "activity", type: "test" } }
const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
const response = { id: "resp_1", model: "gpt-4.1", status: "completed", service_tier: "default", usage }

for (const mode of ["sync", "background_flush"]) {
  test(`${mode}: timeout aborts sends without changing provider results`, async t => {
    let attempts = 0
    let aborted = 0
    t.mock.method(globalThis, "fetch", (_url, { signal }) => {
      attempts++
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted++; reject(signal.reason) }, { once: true })
      })
    })
    t.mock.method(console, "warn", () => {})
    const logged = t.mock.method(console, "error", () => {})
    const sdk = OrluneClient({ apiKey: "test", baseURL: "https://test.invalid", timeoutMs: 10, telemetryDelivery: {
      mode, ...(mode === "background_flush" ? { maxRetries: 1, flushIntervalMs: 60000 } : {}),
    } })
    const client = sdk.wrap({ baseURL: "https://api.openai.com/v1", responses: { async create() { return response } } })
    assert.equal(await client.responses.create({ model: "gpt-4.1", orlune_metadata: metadata }), response)
    await sdk.flush()
    assert.equal(attempts, mode === "sync" ? 1 : 2)
    assert.equal(aborted, attempts)
    assert.equal(logged.mock.callCount(), 1)
  })
}

test("telemetry timeout does not replace provider exceptions", async t => {
  const logged = t.mock.method(console, "error", () => {})
  t.mock.method(globalThis, "fetch", (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  }))
  const error = Object.assign(new Error("provider error"), { request_id: "req_1" })
  const client = OrluneClient({ apiKey: "test", baseURL: "https://test.invalid", timeoutMs: 10, telemetryDelivery: { mode: "sync" } })
    .wrap({ baseURL: "https://api.openai.com/v1", responses: { async create() { throw error } } })
  await assert.rejects(client.responses.create({ model: "gpt-4.1", orlune_metadata: metadata }), caught => caught === error)
  assert.equal(logged.mock.callCount(), 1)
})

for (const [ErrorClass, status] of [
  [OpenAI.APIConnectionTimeoutError, "TIMED_OUT"],
  [OpenAI.APIUserAbortError, "CANCELED"],
  [OpenAI.APIConnectionError, "FAILED"],
]) test(`native ${ErrorClass.name} is recorded as ${status} and rethrown unchanged`, async t => {
  const events = []
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    events.push(JSON.parse(init.body).event)
    return Response.json({})
  })
  const timeout = new ErrorClass({ message: "Custom provider error message" })
  const client = OrluneClient({ apiKey: "test", baseURL: "https://test.invalid" })
    .wrap({ baseURL: "https://api.openai.com/v1", responses: { async create() { throw timeout } } })
  await assert.rejects(client.responses.create({ model: "gpt-4.1", orlune_metadata: metadata }), error => error === timeout)
  assert.equal(events.length, 1)
  assert.equal(events[0].status, status)
})

test("sync HTTP telemetry failures log once without leaking payloads or changing the result", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "private response" }, { status: 403 }))
  const logged = t.mock.method(console, "error", () => {})
  const client = OrluneClient({ apiKey: "secret-key", baseURL: "https://test.invalid" })
    .wrap({ baseURL: "https://api.openai.com/v1", responses: { async create() { return response } } })
  assert.equal(await client.responses.create({ model: "gpt-4.1", orlune_metadata: metadata }), response)
  assert.deepEqual(logged.mock.calls.map(call => call.arguments), [["[orlune] Telemetry delivery failed."]])
})

test("invalid client timeouts fail at initialization", () => {
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
    assert.throws(() => OrluneClient({ apiKey: "test", baseURL: "https://test.invalid", timeoutMs }), /timeoutMs/)
  }
})

for (const status of ["completed", "failed", "incomplete", "cancelled", "queued", "in_progress"]) {
  test(`non-streaming Responses: ${status}`, async t => {
    const events = []
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      events.push(JSON.parse(init.body).event)
      return { ok: true }
    })
    const warnings = []
    t.mock.method(console, "warn", message => warnings.push(message))
    const result = { ...response, status, error: { code: "server_error" }, incomplete_details: { reason: "max_output_tokens" } }
    const client = OrluneClient({ apiKey: "test", baseURL: "https://test.invalid" })
      .wrap({ baseURL: "https://api.openai.com/v1", responses: { async create() { return result } } })
    assert.equal(await client.responses.create({ model: "gpt-4.1", orlune_metadata: metadata }), result)
    if (["queued", "in_progress"].includes(status)) {
      assert.equal(events.length, 0)
      assert.match(warnings[0], /non-terminal/)
      return
    }
    assert.equal(events.length, 1)
    assert.equal(events[0].status, status === "completed" ? "SUCCEEDED" : status === "cancelled" ? "CANCELED" : "FAILED")
    assert.equal(events[0].requestId, result.id)
    assert.deepEqual(events[0].providerEvent.openai.usage, usage)
    if (status === "incomplete") assert.equal(events[0].errorCode, "max_output_tokens")
    if (status === "failed") assert.equal(events[0].errorCode, "server_error")
  })
}
