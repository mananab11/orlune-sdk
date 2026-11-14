import test from "node:test"
import assert from "node:assert/strict"
import { OrluneClient, OrluneEvaluationException, OrluneGuardrailException } from "../dist/index.js"

const options = { apiKey: "test", baseURL: "https://test.invalid" }
const metadata = { customerId: "customer", eventType: "GENERATE", activity: { id: "activity", type: "draft" } }
const request = { customerId: "customer", activity: { id: "activity", type: "draft" } }
const blocked = { evaluationId: "evaluation", evaluatedAt: "2026-11-13T00:00:00Z", decision: "BLOCK",
  reasonCode: "INTENT_NOT_ALLOWED", matchedRule: { id: "policy", name: "Intent", message: "Outside allowed purposes" } }

function provider(family, create) {
  const endpoint = { create }
  const client = family === "openai"
    ? { baseURL: "https://api.openai.com/v1", responses: endpoint }
    : { baseURL: "https://api.anthropic.com", messages: endpoint }
  return { client, endpoint }
}

test("one client's immutable settings protect both providers, including wrappers created later", async t => {
  let checks = 0
  t.mock.method(globalThis, "fetch", async url => {
    assert.ok(url.endsWith("/evaluate"))
    checks++
    return Response.json(blocked)
  })
  const guardrails = { enabled: true, onError: "throw" }
  const config = { ...options, guardrails, timeoutMs: 5000 }
  const sdk = OrluneClient(config)
  const first = provider("openai", () => assert.fail("Blocked provider must not run"))
  sdk.wrap(first.client)
  guardrails.enabled = false
  guardrails.onError = "allow"
  config.timeoutMs = 1
  config.guardrails = { enabled: false }
  const second = provider("anthropic", () => assert.fail("Blocked provider must not run"))
  sdk.wrap(second.client)
  for (const { endpoint } of [first, second]) {
    await assert.rejects(endpoint.create({ orlune_metadata: metadata }), OrluneGuardrailException)
  }
  assert.equal(checks, 2)
})

test("disabled automatic checks remain disabled after mutation; explicit evaluation still returns BLOCK", async t => {
  const calls = []
  t.mock.method(globalThis, "fetch", async url => {
    calls.push(url)
    return Response.json(url.endsWith("/evaluate") ? blocked : {})
  })
  const guardrails = { enabled: false }
  const sdk = OrluneClient({ ...options, guardrails })
  guardrails.enabled = true
  for (const family of ["openai", "anthropic"]) {
    const raw = provider(family, async () => ({ id: "request", model: "model", usage: { input_tokens: 1, output_tokens: 1 } }))
    sdk.wrap(raw.client)
    await raw.endpoint.create({ orlune_metadata: metadata })
  }
  assert.equal(calls.filter(url => url.endsWith("/evaluate")).length, 0)
  assert.deepEqual(await sdk.evaluate(request), blocked)
  assert.equal(calls.filter(url => url.endsWith("/evaluate")).length, 1)
})

test("client failure behavior applies to both providers but never converts explicit evaluation failures", async t => {
  t.mock.method(console, "warn", () => {})
  t.mock.method(globalThis, "fetch", async url => url.endsWith("/evaluate")
    ? new Response(null, { status: 503 }) : Response.json({}))
  const guardrails = { enabled: true, onError: "allow" }
  const sdk = OrluneClient({ ...options, guardrails })
  guardrails.onError = "throw"
  let providerCalls = 0
  for (const family of ["openai", "anthropic"]) {
    const raw = provider(family, async () => {
      providerCalls++
      return { id: "request", model: "model", usage: { input_tokens: 1, output_tokens: 1 } }
    })
    sdk.wrap(raw.client)
    await raw.endpoint.create({ orlune_metadata: metadata })
  }
  assert.equal(providerCalls, 2)
  await assert.rejects(sdk.evaluate(request), error => error instanceof OrluneEvaluationException && error.status === 503)
})

test("automatic and explicit evaluations share the snapshotted client timeout", async t => {
  const durations = []
  const nativeTimeout = globalThis.setTimeout
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    durations.push(delay)
    return nativeTimeout(callback, delay, ...args)
  })
  t.mock.method(globalThis, "fetch", async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
  }))
  const config = { ...options, guardrails: { enabled: true }, timeoutMs: 5 }
  const sdk = OrluneClient(config)
  config.timeoutMs = 60000
  for (const family of ["openai", "anthropic"]) {
    const raw = provider(family, () => assert.fail("Timed-out check must not call provider"))
    sdk.wrap(raw.client)
    await assert.rejects(raw.endpoint.create({ orlune_metadata: metadata }), error => error.code === "TIMEOUT")
  }
  await assert.rejects(sdk.evaluate(request), error => error.code === "TIMEOUT")
  assert.deepEqual(durations, [5, 5, 5])
})

for (const timeoutMs of [undefined, 1234]) test(`evaluation and telemetry share timeout ${timeoutMs ?? 5000}ms; provider options remain unchanged`, async t => {
  const durations = []
  const nativeTimeout = globalThis.setTimeout
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    durations.push(delay)
    return nativeTimeout(callback, delay, ...args)
  })
  t.mock.method(globalThis, "fetch", async url => Response.json(url.endsWith("/evaluate")
    ? { ...blocked, decision: "ALLOW", matchedRule: null } : {}))
  const config = { ...options, timeoutMs, guardrails: { enabled: true }, telemetryDelivery: { mode: "sync" } }
  const sdk = OrluneClient(config)
  config.timeoutMs = 60000
  const providerOptions = { timeout: 9000, signal: new AbortController().signal }
  for (const family of ["openai", "anthropic"]) {
    const raw = provider(family, async (_input, receivedOptions) => {
      assert.equal(receivedOptions, providerOptions)
      return { id: "request", model: "model", usage: { input_tokens: 1, output_tokens: 1 } }
    })
    sdk.wrap(raw.client)
    await raw.endpoint.create({ orlune_metadata: metadata }, providerOptions)
  }
  await sdk.evaluate(request)
  assert.deepEqual(durations, Array(5).fill(timeoutMs ?? 5000))
})
