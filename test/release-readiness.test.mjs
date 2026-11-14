import test from "node:test"
import assert from "node:assert/strict"
import { OrluneClient, TelemetryMode, GuardrailErrorMode } from "../dist/index.js"

const metadata = { customerId: "customer", eventType: "TEST", feature: "support", activity: { id: "activity", type: "test" } }
const options = { apiKey: "test", baseURL: "https://test.invalid" }
const provider = create => ({ baseURL: "https://api.openai.com/v1", responses: { create } })

test("configuration constants are frozen and work with the public client", () => {
  for (const constants of [TelemetryMode, GuardrailErrorMode]) assert.ok(Object.isFrozen(constants))
  const sdk = OrluneClient({ ...options, telemetryDelivery: { mode: TelemetryMode.BackgroundFlush }, guardrails: { enabled: true, onError: GuardrailErrorMode.Allow } })
  sdk.wrap(provider(() => {}))
})

test("invalid guardrail configuration fails at setup, before modifying the provider", () => {
  for (const guardrails of [null, {}, { enabled: "false" }, { enabled: 1 }, { enabled: true, onError: "alow" }]) {
    const original = () => {}
    const raw = provider(original)
    assert.throws(() => OrluneClient({ ...options, guardrails }).wrap(raw), /guardrails/)
    assert.equal(raw.responses.create, original)
  }
  for (const timeoutMs of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
    assert.throws(() => OrluneClient({ ...options, timeoutMs }), /timeoutMs/)
  }
})

test("both adapters require customerId and eventType; feature remains optional", async t => {
  const sent = []
  t.mock.method(globalThis, "fetch", async (_url, init) => { sent.push(JSON.parse(init.body)); return new Response(null, { status: 202 }) })
  for (const family of ["openai", "anthropic"]) {
    let calls = 0
    const endpoint = { async create() { calls++; return { id: "request", model: "model", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } } }
    const raw = family === "openai" ? { baseURL: "https://api.openai.com/v1", responses: endpoint }
      : { baseURL: "https://api.anthropic.com", messages: endpoint }
    OrluneClient(options).wrap(raw)
    assert.throws(() => endpoint.create(), /activity.type/)
    for (const [field, max] of [["customerId", 256], ["eventType", 128]]) {
      for (const value of [undefined, null, "", " ", 42, "x".repeat(max + 1)]) {
        assert.throws(() => endpoint.create({ orlune_metadata: { ...metadata, [field]: value } }), new RegExp(field))
      }
    }
    assert.equal(calls, 0)
    const { feature, ...withoutFeature } = metadata
    await endpoint.create({ model: "model", orlune_metadata: withoutFeature })
    assert.equal(sent.at(-1).event.feature, "UNKNOWN")
  }
})

test("OpenAI telemetry capture errors preserve a successful response", async t => {
  const errors = t.mock.method(console, "error", () => {})
  const fetch = t.mock.method(globalThis, "fetch", () => { assert.fail("No telemetry should be sent") })
  const result = { id: "request", model: "model", status: "completed", usage: { input_tokens: 1, extension() {} } }
  const client = OrluneClient(options).wrap(provider(async () => result))
  assert.equal(await client.responses.create({ orlune_metadata: metadata }), result)
  assert.equal(errors.mock.callCount(), 1)
  assert.equal(fetch.mock.callCount(), 0)
})

test("OpenAI failure capture errors preserve the original provider exception", async t => {
  const errors = t.mock.method(console, "error", () => {})
  const failure = new Error("Provider failed")
  Object.defineProperty(failure, "requestID", { get() { throw new Error("Capture failure") } })
  for (const create of [() => { throw failure }, async () => { throw failure }]) {
    const client = OrluneClient(options).wrap(provider(create))
    await assert.rejects(client.responses.create({ orlune_metadata: metadata }), error => error === failure)
  }
  assert.equal(errors.mock.callCount(), 2)
})

for (const family of ["responses", "chat"]) test(`OpenAI ${family} stream snapshots usage before the caller can mutate it`, async t => {
  const sent = []
  t.mock.method(globalThis, "fetch", async (_url, init) => { sent.push(JSON.parse(init.body)); return new Response(null, { status: 202 }) })
  const usage = family === "responses" ? { input_tokens: 10, output_tokens: 5 } : { prompt_tokens: 10, completion_tokens: 5 }
  const endpoint = { async create() { return (async function* () {
    yield family === "responses" ? { type: "response.completed", response: { id: "request", model: "model", usage } }
      : { id: "request", model: "model", usage, choices: [] }
  })() } }
  const raw = { baseURL: "https://api.openai.com/v1", ...(family === "responses" ? { responses: endpoint } : { chat: { completions: endpoint } }) }
  OrluneClient(options).wrap(raw)
  for await (const chunk of await endpoint.create({ stream: true, orlune_metadata: metadata })) {
    const observed = family === "responses" ? chunk.response.usage : chunk.usage
    observed[family === "responses" ? "input_tokens" : "prompt_tokens"] = 999
  }
  assert.equal(sent.length, 1)
  assert.equal(sent[0].event.providerEvent.openai.usage[family === "responses" ? "input_tokens" : "prompt_tokens"], 10)
})

test("OpenAI stream capture errors do not fail iteration", async t => {
  const errors = t.mock.method(console, "error", () => {})
  const chunk = { type: "response.completed", response: { usage: { extension() {} } } }
  const client = OrluneClient(options).wrap(provider(async () => (async function* () { yield chunk })()))
  const seen = []
  for await (const item of await client.responses.create({ stream: true, orlune_metadata: metadata })) seen.push(item)
  assert.deepEqual(seen, [chunk])
  assert.equal(errors.mock.callCount(), 1)
})
