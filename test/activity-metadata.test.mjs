import test from "node:test"
import assert from "node:assert/strict"
import { ensureActivityMetadata } from "../dist/metadata/ensure-activity-metadata.js"
import { mergeOrluneMetadata } from "../dist/metadata/merge-orlune-metadata.js"
import { OrluneClient } from "../dist/index.js"

test("activity type is explicit, validated, and never inferred from feature", () => {
  for (const type of [undefined, "", " ", 42, "x".repeat(129)]) {
    assert.throws(() => ensureActivityMetadata({ feature: "support", activity: { type } }), /activity.type/)
  }
  assert.throws(() => ensureActivityMetadata(), /activity.type/)
  assert.equal(ensureActivityMetadata({ customerId: "customer", eventType: "TEST", activity: { id: "activity", type: "x".repeat(128) } }).activity.type.length, 128)
})

test("activity comes only from the call, never from old defaults", () => {
  const defaults = { feature: "support", activity: { id: "conversation", type: "support", name: "old default" } }
  assert.throws(() => ensureActivityMetadata(mergeOrluneMetadata(defaults, { customerId: "Nike" })), /activity.type/)
  const overridden = ensureActivityMetadata(mergeOrluneMetadata(defaults, { customerId: "customer", eventType: "TEST", activity: { id: "refund", type: "refund", name: "old name" } }))
  assert.equal(overridden.activity.type, "refund")
  assert.equal(overridden.feature, "support")
  assert.equal(overridden.activity.id, "refund")
  assert.equal("name" in overridden.activity, false)
  assert.equal(defaults.activity.id, "conversation")
})

test("per-call activity replaces defaults and cannot inherit a missing type", () => {
  const defaults = { activity: { id: "default", type: "support" } }
  for (const activity of [{}, { id: "conversation" }, { type: "" }]) {
    assert.throws(() => ensureActivityMetadata(mergeOrluneMetadata(defaults, { activity })), /activity.type/)
  }
  const replacement = { id: "refund-123", type: "refund" }
  assert.deepEqual(ensureActivityMetadata(mergeOrluneMetadata(defaults, { customerId: "customer", eventType: "TEST", activity: replacement })).activity, replacement)
})

test("activity IDs are mandatory strings with a 256-character maximum", () => {
  for (const id of [undefined, null, "", " ", 42, "x".repeat(257)]) {
    assert.throws(() => ensureActivityMetadata({ activity: { id, type: "support" } }), /activity.id/)
  }
  const activity = { id: "x".repeat(256), type: "support" }
  assert.deepEqual(ensureActivityMetadata({ customerId: "customer", eventType: "TEST", activity }).activity, activity)
})

test("both provider adapters reject missing type before invoking the provider", () => {
  const sdk = OrluneClient({ apiKey: "test", baseURL: "https://test.invalid" })
  let calls = 0
  for (const provider of ["openai", "anthropic"]) {
    const method = { create() { calls++; throw new Error("Provider must not run") } }
    const raw = provider === "openai"
      ? { baseURL: "https://api.openai.com/v1", responses: method }
      : { baseURL: "https://api.anthropic.com", messages: method }
    const wrapped = sdk.wrap(raw)
    assert.throws(() => (wrapped.responses ?? wrapped.messages).create({
      orlune_metadata: { customerId: "Nike", eventType: "TEST", feature: "support" },
    }), /activity.type/)
    assert.throws(() => (wrapped.responses ?? wrapped.messages).create({
      orlune_metadata: { customerId: "Nike", eventType: "TEST", activity: { type: "support" } },
    }), /activity.id/)
  }
  assert.equal(calls, 0)
})

test("direct evaluation requires activity.type without making a network call", async () => {
  const sdk = OrluneClient({ apiKey: "test", baseURL: "https://test.invalid" })
  await assert.rejects(sdk.evaluate({ customerId: "Nike", activity: { id: "conversation" } }),
    error => error.code === "INVALID_REQUEST" && /activity.type/.test(error.message))
})
