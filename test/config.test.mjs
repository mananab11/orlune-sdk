import test from "node:test"
import assert from "node:assert/strict"
import { OrluneClient } from "../dist/index.js"
import { resolveBaseURL, PRODUCTION_BASE_URL } from "../dist/config.js"

test("baseURL defaults to production and normalizes valid testing origins", () => {
  assert.equal(resolveBaseURL(), PRODUCTION_BASE_URL)
  for (const url of ["https://test.invalid", "http://localhost:3100", "http://127.0.0.1:3100", "http://[::1]:3100"]) {
    assert.equal(resolveBaseURL(url + "/"), url)
  }
})

test("invalid baseURL and removed environment option fail before any request", () => {
  for (const baseURL of [null, "", " ", 1, {}, "sandbox", "http://test.invalid",
    "ftp://localhost", "https://user:password@test.invalid", "https://test.invalid/v1",
    "https://test.invalid?token=x", "https://test.invalid#fragment"]) {
    assert.throws(() => OrluneClient({ apiKey: "test", baseURL }), /baseURL/)
  }
  assert.throws(() => OrluneClient({ apiKey: "test", environment: "sandbox" }), /no longer supported/)
})

for (const baseURL of [undefined, "https://test.invalid/", "http://localhost:3100"]) {
  test(`telemetry and evaluation use the same origin: ${baseURL ?? "production"}`, async t => {
    const urls = []
    t.mock.method(globalThis, "fetch", async url => {
      urls.push(url)
      return url.endsWith("/evaluate")
        ? Response.json({ evaluationId: "eval", evaluatedAt: new Date().toISOString(), reasonCode: "NO_ACTIVE_POLICIES", decision: "NOT_EVALUATED", matchedRule: null })
        : new Response(null, { status: 202 })
    })
    const sdk = OrluneClient({ apiKey: "test", ...(baseURL === undefined ? {} : { baseURL }) })
    const client = sdk.wrap({ baseURL: "https://api.openai.com/v1", responses: {
      async create() { return { id: "request", model: "model", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
    } })
    await client.responses.create({ orlune_metadata: { customerId: "customer", eventType: "TEST", feature: "test", activity: { id: "activity", type: "test" } } })
    await sdk.evaluate({ customerId: "customer", activityId: "activity", activityType: "test" })
    const origin = baseURL ?? PRODUCTION_BASE_URL
    assert.deepEqual(urls, [new URL("/v1/events", origin).href, new URL("/v1/guardrails/evaluate", origin).href])
  })
}
