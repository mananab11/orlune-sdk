import test from "node:test"
import assert from "node:assert/strict"
import { createTelemetryTransport } from "../dist/internal/telemetry-transport.js"

const event = { event: { requestId: "test" } }
const transport = () => createTelemetryTransport({
  apiKey: "test", endpoint: "https://test.invalid", timeoutMs: 100,
})

for (const status of [202, 403, 500]) {
  test(`telemetry releases an unfinished HTTP ${status} response body`, async t => {
    let cancelled = 0
    let signal
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"status":')) },
      cancel() { cancelled++ },
    }), { status })
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      signal = init.signal
      return response
    })
    if (status === 202) await transport().send(event)
    else await assert.rejects(transport().send(event), new RegExp(`status ${status}`))
    assert.equal(cancelled, 1)
    assert.equal(response.bodyUsed, true)
    assert.equal(signal.aborted, true)
  })
}

for (const behavior of ["throws", "rejects", "never settles"]) {
  test(`cleanup that ${behavior} does not delay or change delivery outcomes`, async t => {
    for (const status of [202, 500]) {
      let cancelled = 0
      let signal
      t.mock.method(globalThis, "fetch", async (_url, init) => {
        signal = init.signal
        return { ok: status === 202, status, body: {
          cancel() {
            cancelled++
            if (behavior === "throws") throw new Error("cleanup failed")
            if (behavior === "rejects") return Promise.reject(new Error("cleanup failed"))
            return new Promise(() => {})
          },
        } }
      })
      if (status === 202) await transport().send(event)
      else await assert.rejects(transport().send(event), /status 500/)
      assert.equal(cancelled, 1)
      assert.equal(signal.aborted, true)
    }
    await new Promise(setImmediate)
  })
}

test("empty telemetry responses and fetch failures retain their outcomes", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }))
  await transport().send(event)
  const failure = new Error("network failed")
  t.mock.method(globalThis, "fetch", async () => { throw failure })
  await assert.rejects(transport().send(event), error => error === failure)
})
