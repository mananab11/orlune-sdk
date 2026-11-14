import test from "node:test"
import assert from "node:assert/strict"
import { OrluneClient, OrluneEvaluationException } from "../dist/index.js"

const decision = { evaluationId: "evaluation", evaluatedAt: "2026-11-13T00:00:00Z",
  decision: "ALLOW", reasonCode: "NO_RULE_TRIGGERED", matchedRule: null }
const client = () => OrluneClient({ apiKey: "test", baseURL: "https://test.invalid", guardrails: { enabled: true } })

test("explicit and automatic evaluations reuse an activity without changing the backend contract", async t => {
  const evaluations = []
  const telemetry = []
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body)
    if (url.endsWith("/evaluate")) {
      evaluations.push(body)
      return Response.json(decision)
    }
    telemetry.push(body.event)
    return Response.json({})
  })
  const sdk = client()
  const activity = Object.freeze({ id: "listing-123", type: "create_listing" })
  const context = Object.freeze({ customerId: "merchant", feature: "Listings", activity })
  assert.deepEqual(await sdk.evaluate(context), decision)
  for (const family of ["openai", "anthropic"]) {
    const endpoint = { async create() { return { id: family, model: "model", usage: { input_tokens: 1, output_tokens: 1 } } } }
    sdk.wrap(family === "openai" ? { baseURL: "https://api.openai.com/v1", responses: endpoint }
      : { baseURL: "https://api.anthropic.com", messages: endpoint })
    await endpoint.create({ orlune_metadata: { ...context, eventType: "GENERATE" } })
  }
  assert.equal(evaluations.length, 3)
  for (const body of evaluations) {
    assert.deepEqual(body, { customerId: "merchant", feature: "Listings", activityId: "listing-123", activityType: "create_listing" })
  }
  assert.equal(telemetry.length, 2)
  for (const event of telemetry) {
    assert.equal(event.operation.id, activity.id)
    assert.equal(event.operation.type, activity.type)
  }
})

test("invalid activity shapes and fields fail with INVALID_REQUEST before fetching", async t => {
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("No network call expected"))
  const sdk = client()
  const invalid = [undefined, null, [], "listing", 42, {}, { id: "listing" }, { type: "draft" }]
  for (const field of ["id", "type"]) {
    for (const value of [null, "", " ", 123, "x".repeat(field === "id" ? 257 : 129)]) {
      invalid.push({ id: "listing", type: "draft", [field]: value })
    }
  }
  for (const activity of invalid) {
    await assert.rejects(sdk.evaluate({ customerId: "merchant", activity }), error =>
      error instanceof OrluneEvaluationException && error.code === "INVALID_REQUEST" && /activity/.test(error.message))
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test("maximum activity lengths serialize unchanged and optional fields stay optional", async t => {
  const activity = { id: "i".repeat(256), type: "t".repeat(128) }
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { customerId: "merchant", activityId: activity.id, activityType: activity.type })
    return Response.json(decision)
  })
  assert.deepEqual(await client().evaluate({ customerId: "merchant", activity }), decision)
})
