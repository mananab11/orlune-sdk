import test from "node:test"
import assert from "node:assert/strict"
import { OrluneClient } from "../dist/index.js"
import { observeProviderCall } from "../dist/providers/observe-provider-call.js"
import { Stream } from "openai/core/streaming"

const metadata = { customerId: "customer", eventType: "test", feature: "test", activity: { id: "activity", type: "test" } }
const input = { model: "model", orlune_metadata: metadata }
const chunks = [
  { type: "message_start", message: { id: "message", model: "model", usage: { input_tokens: 1 } } },
  { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]

function client(family, create, telemetryDelivery) {
  const sdk = OrluneClient({ apiKey: "test", baseURL: "https://test.invalid", telemetryDelivery })
  const raw = family === "anthropic"
    ? { baseURL: "https://api.anthropic.com", messages: { create } }
    : { baseURL: "https://api.openai.com/v1", responses: { create } }
  sdk.wrap(raw)
  return { sdk, create: family === "anthropic" ? raw.messages.create : raw.responses.create }
}

test("Anthropic capture failure stops telemetry, not chunks or subsequent provider errors", async t => {
  const log = t.mock.method(console, "error", () => {})
  const send = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected telemetry") })
  for (const failProvider of [false, true]) {
    const failure = new Error("provider failed later")
    let closed = false
    const source = { async *[Symbol.asyncIterator]() {
      try {
        yield* chunks
        if (failProvider) throw failure
      } finally { closed = true }
    } }
    const wrapped = client("anthropic", async () => source)
    const stream = await wrapped.create({ ...input, stream: true })
    const clone = t.mock.method(globalThis, "structuredClone", () => { throw new Error("snapshot bug") })
    const seen = []
    const consume = async () => { for await (const chunk of stream) seen.push(chunk) }
    try {
      if (failProvider) await assert.rejects(consume(), error => error === failure)
      else await consume()
      assert.deepEqual(seen, chunks)
      assert.equal(closed, true)
      assert.equal(clone.mock.callCount(), 1)
    } finally { clone.mock.restore() }
  }
  assert.equal(send.mock.callCount(), 0)
  assert.equal(log.mock.callCount(), 2)
})

for (const family of ["anthropic", "openai"]) {
  test(`${family}: a read-only stream still delivers native chunks`, async t => {
    t.mock.method(console, "error", () => {})
    const send = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected telemetry") })
    const controller = new AbortController()
    const addListener = t.mock.method(controller.signal, "addEventListener")
    const source = Object.freeze({ controller, async *[Symbol.asyncIterator]() { yield* chunks } })
    const wrapped = client(family, async () => source)
    const result = await wrapped.create({ ...input, stream: true })
    const seen = []
    for await (const chunk of result) seen.push(chunk)
    assert.equal(result, source)
    assert.deepEqual(seen, chunks)
    assert.equal(send.mock.callCount(), 0)
    assert.equal(addListener.mock.callCount(), 0)
  })

  for (const mode of ["sync", "background_flush"]) {
    test(`${family}: ${mode} delivery and logger failures cannot change provider outcomes`, async t => {
      t.mock.method(console, "error", () => { throw new Error("logger failed") })
      t.mock.method(globalThis, "fetch", async () => { throw new Error("telemetry offline") })
      const response = { id: "request", model: "model", usage: { input_tokens: 1, output_tokens: 1 } }
      const failure = new Error("original provider failure")
      const delivery = mode === "sync" ? { mode } : { mode, maxRetries: 0 }
      const success = client(family, async () => response, delivery)
      assert.equal(await success.create(input), response)
      await success.sdk.flush()
      for (const create of [() => { throw failure }, async () => { throw failure }]) {
        const failed = client(family, create, delivery)
        await assert.rejects(failed.create(input), error => error === failure)
        await failed.sdk.flush()
      }
    })
  }
}

test("OpenAI read-only native iterator factory falls back without attaching listeners", async t => {
  t.mock.method(console, "error", () => {})
  const send = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected telemetry") })
  const controller = new AbortController()
  const chunk = { type: "response.completed", response: { id: "request", model: "model", usage: { input_tokens: 1 } } }
  const native = Stream.fromSSEResponse(new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`), controller)
  Object.freeze(native)
  const addListener = t.mock.method(controller.signal, "addEventListener")
  const wrapped = client("openai", async () => native)
  const stream = await wrapped.create({ ...input, stream: true })
  assert.equal(stream, native)
  assert.equal(addListener.mock.callCount(), 0)
  const seen = []
  for await (const item of stream) seen.push(item)
  assert.deepEqual(seen, [chunk])
  assert.equal(send.mock.callCount(), 0)
})

test("shared observer returns the original result when observation fails", async t => {
  t.mock.method(console, "error", () => { throw new Error("logger failed") })
  const response = { answer: "hello" }
  let reports = 0
  const call = observeProviderCall({
    start: async () => ({ value: response }),
    readResult: async value => value,
    onResult: async () => { throw new Error("observation bug") },
    onError: async () => { reports++ },
  })
  assert.equal(await call.result(), response)
  assert.equal(reports, 0)
})

test("shared observer preserves the provider error when error reporting fails", async t => {
  t.mock.method(console, "error", () => { throw new Error("logger failed") })
  for (const asyncFailure of [false, true]) {
    const failure = new Error("provider failed")
    const call = observeProviderCall({
      start: async () => ({ value: null }),
      readResult: async () => { throw failure },
      onResult: async value => value,
      onError: () => {
        const error = new Error("reporting failed")
        if (asyncFailure) return Promise.reject(error)
        throw error
      },
    })
    await assert.rejects(call.result(), error => error === failure)
  }
})
