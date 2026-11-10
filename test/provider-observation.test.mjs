import test from "node:test"
import assert from "node:assert/strict"
import { observeProviderCall } from "../dist/providers/observe-provider-call.js"
import { stripWrappedRequestMetadata } from "../dist/metadata/strip-wrapped-request-metadata.js"
import { OrluneClient } from "../dist/index.js"
import { detectSupportedProvider } from "../dist/providers/detect-client.js"

test("shared lifecycle observes a provider-specific result without OpenAI helpers", async () => {
  let invocations = 0
  let reads = 0
  let observations = 0
  const native = { async finish() { reads++; return { answer: "hello", billedUnits: 3 } } }
  const call = observeProviderCall({
    start: async () => { invocations++; return { value: native } },
    readResult: value => value.finish(),
    onResult: async result => { observations++; return result },
    onError: async () => assert.fail("no failure expected"),
  })
  assert.equal(reads, 0)
  assert.equal(await call.read(async value => value), native)
  assert.equal(observations, 0)
  const [first, second] = await Promise.all([call.result(), call.result()])
  assert.equal(first, second)
  assert.deepEqual(first, { answer: "hello", billedUnits: 3 })
  assert.equal(invocations, 1)
  assert.equal(reads, 1)
  assert.equal(observations, 1)
})

test("concurrent provider failures share one completed error observation", async () => {
  const error = new Error("provider failed")
  let observed = 0
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const call = observeProviderCall({
    start: async () => ({ value: {} }),
    readResult: async () => { throw error },
    onResult: async result => result,
    onError: async () => { await barrier; observed++ },
  })
  const results = Promise.allSettled([call.result(), call.read(async () => { throw error })])
  release()
  for (const result of await results) {
    assert.equal(result.status, "rejected")
    assert.equal(result.reason, error)
  }
  assert.equal(observed, 1)
})

test("preflight rejection bypasses provider result and error observation", async () => {
  const denied = new Error("preflight denied")
  const call = observeProviderCall({
    start: async () => { throw denied },
    readResult: async () => assert.fail("provider reader must not run"),
    onResult: async () => assert.fail("result observer must not run"),
    onError: async () => assert.fail("provider error observer must not run"),
  })
  await assert.rejects(call.result(), error => error === denied)
})

test("metadata extraction is provider-neutral and does not mutate input", () => {
  const input = Object.freeze({ text: "hello", controls: { temperature: 0.3 },
    orlune_metadata: { customerId: "c", eventType: "MODEL_CALL" } })
  const { cleanInput, orluneMetadata } = stripWrappedRequestMetadata(input)
  assert.equal(orluneMetadata, input.orlune_metadata)
  assert.equal(cleanInput.controls, input.controls)
  assert.equal(cleanInput.text, input.text)
  assert.equal("orlune_metadata" in cleanInput, false)
  assert.ok(input.orlune_metadata)
})

test("adapter registry identifies supported methods and rejects unimplemented providers", () => {
  assert.equal(detectSupportedProvider({ baseURL: "https://api.openai.com/v1", responses: { create() {} } }), "OPENAI")
  assert.equal(detectSupportedProvider({ baseURL: "https://api.openai.com/v1", chat: { completions: { create() {} } } }), "OPENAI")
  const unknown = { messages: { create() {} } }
  assert.equal(detectSupportedProvider(unknown), null)
  assert.throws(() => OrluneClient({ apiKey: "test", environment: "sandbox" }).wrap(unknown), /Unsupported provider/)
})
