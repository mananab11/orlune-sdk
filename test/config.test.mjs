import test from "node:test"
import assert from "node:assert/strict"
import { OrluneClient } from "../dist/index.js"
import { resolveEventsEndpoint, ORLUNE_PRODUCTION_EVENTS_URL, ORLUNE_DEVELOPMENT_EVENTS_URL } from "../dist/config.js"

test("environment routing keeps production, development, and sandbox separate", () => {
  assert.equal(ORLUNE_PRODUCTION_EVENTS_URL, "https://dx02lonqo8.execute-api.us-east-1.amazonaws.com/v1/events")
  assert.equal(ORLUNE_DEVELOPMENT_EVENTS_URL, "https://tcum999ahg.execute-api.us-east-1.amazonaws.com/v1/events")
  assert.equal(resolveEventsEndpoint("production"), ORLUNE_PRODUCTION_EVENTS_URL)
  assert.equal(resolveEventsEndpoint("development"), ORLUNE_DEVELOPMENT_EVENTS_URL)
  assert.equal(resolveEventsEndpoint("sandbox"), "https://du37zudv2g.execute-api.us-west-2.amazonaws.com/v1/events")
})

test("client initialization rejects invalid or missing environments", () => {
  for (const environment of [undefined, null, "", "prod", "Sandbox", " sandbox ", 1, {}]) {
    assert.throws(
      () => OrluneClient({ apiKey: "test", environment }),
      /environment must be "production", "development", or "sandbox"/,
    )
  }
  for (const environment of ["production", "development", "sandbox"]) {
    assert.doesNotThrow(() => OrluneClient({ apiKey: "test", environment }))
  }
})
