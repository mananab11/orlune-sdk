import test from "node:test"
import assert from "node:assert/strict"
import { checkGuardrails } from "../dist/internal/check-guardrails.js"
import { createEvaluator } from "../dist/internal/evaluation-transport.js"
import { OrluneEvaluationException, OrluneGuardrailException } from "../dist/index.js"

const metadata = { customerId: "customer", eventType: "test", activity: { id: "activity", type: "test" } }

test("throwing warning logger does not override guardrail failure settings", async t => {
  t.mock.method(console, "warn", () => { throw new Error("logger failed") })
  const failure = new OrluneEvaluationException("timed out", "TIMEOUT")
  const evaluate = async () => { throw failure }
  await checkGuardrails(evaluate, { enabled: true, onError: "allow" }, metadata)
  await assert.rejects(checkGuardrails(evaluate, { enabled: true }, metadata), error => error === failure)
  const blocked = { decision: "BLOCK", matchedRule: { id: "rule", name: "Rule", message: "Blocked" } }
  await assert.rejects(checkGuardrails(async () => blocked, { enabled: true, onError: "allow" }, metadata),
    error => error instanceof OrluneGuardrailException)
})

test("throwing warning logger does not prevent unevaluated requests from proceeding", async t => {
  t.mock.method(console, "warn", () => { throw new Error("logger failed") })
  for (const reasonCode of ["NO_ACTIVE_POLICIES", "EVALUATION_LIMIT_EXCEEDED"]) {
    await checkGuardrails(async () => ({ decision: "NOT_EVALUATED", reasonCode }),
      { enabled: true }, metadata)
  }
})

test("throwing warning logger does not prevent prompt truncation and evaluation", async t => {
  t.mock.method(console, "warn", () => { throw new Error("logger failed") })
  const result = { decision: "ALLOW", matchedRule: null, evaluationId: "evaluation",
    evaluatedAt: new Date().toISOString(), reasonCode: "NO_MATCH" }
  let prompt
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    prompt = JSON.parse(init.body).prompt
    return Response.json(result)
  })
  const evaluate = createEvaluator("test", "https://test.invalid")
  assert.deepEqual(await evaluate({ customerId: "customer", activity: { id: "activity", type: "test" },
    prompt: "x".repeat(100001) }), result)
  assert.equal(prompt.length, 100000)
})
