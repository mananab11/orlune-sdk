import test from "node:test"
import assert from "node:assert/strict"
import { OrluneClient, OrluneGuardrailException, OrluneEvaluationException } from "../dist/index.js"
import { extractOpenAIPrompt } from "../dist/providers/openai/extract-prompt.js"

const request = { customerId: "customer", feature: "summaries", activityId: "activity" }
const metadata = { customerId: "customer", eventType: "MODEL_CALL", activity: { id: "activity" } }
const result = (decision = "ALLOW") => ({
  evaluationId: "evaluation-1", evaluatedAt: "2026-10-04T00:00:00Z", decision,
  reasonCode: decision === "BLOCK" ? "LIMIT_EXCEEDED" : "NO_RULE_TRIGGERED",
  matchedRule: decision === "BLOCK" ? { id: "rule", name: "Daily limit", message: "Daily budget reached" } : null,
  details: { observedValue: 101, thresholdValue: 100 },
})
const makeClient = (options = {}) => OrluneClient({ apiKey: "key", environment: "production", ...options })
const response = { _request_id: "req-1", model: "gpt-4.1-mini", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }
const quotaResult = {
  evaluationId: "quota-check-1", evaluatedAt: "2026-10-04T00:00:00Z",
  decision: "NOT_EVALUATED", reasonCode: "EVALUATION_LIMIT_EXCEEDED", matchedRule: null,
}

test("explicit evaluation exposes both skip reasons, not an error or permission to proceed", async t => {
  for (const reasonCode of ["NO_ACTIVE_POLICIES", "EVALUATION_LIMIT_EXCEEDED"]) {
    const skipped = { ...quotaResult, reasonCode }
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(skipped))
    assert.deepEqual(await makeClient().evaluate(request), skipped)
    fetch.mock.restore()
  }
})

for (const reasonCode of ["NO_ACTIVE_POLICIES", "EVALUATION_LIMIT_EXCEEDED"]) {
test(`${reasonCode} proceeds once for both APIs and streams, independent of onError, with normal telemetry`, async t => {
  const warnings = t.mock.method(console, "warn", () => {})
  for (const family of ["responses", "chat"]) {
    for (const stream of [false, true]) {
      for (const onError of ["throw", "allow"]) {
        let checks = 0, providerCalls = 0, telemetry = 0
        const fetch = t.mock.method(globalThis, "fetch", async url => {
          if (url.endsWith("/evaluate")) { checks++; return Response.json({ ...quotaResult, reasonCode }) }
          telemetry++
          return new Response(null, { status: 202 })
        })
        const native = family === "responses" ? response : { ...response, id: "chat-1",
          choices: [{ message: { content: "Hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }
        const endpoint = { async create(input) {
          providerCalls++
          assert.equal(input.orlune_metadata, undefined)
          if (!stream) return native
          return (async function* () {
            if (family === "responses") {
              yield { type: "response.output_text.delta", delta: "Hello" }
              yield { type: "response.completed", response: native }
            } else {
              yield { id: "chat-1", model: native.model, choices: [{ delta: { content: "Hello" }, finish_reason: null }] }
              yield { id: "chat-1", model: native.model, choices: [{ delta: {}, finish_reason: "stop" }], usage: native.usage }
            }
          })()
        } }
        const sdk = makeClient()
        sdk.wrap(family === "responses" ? { baseURL: "https://api.openai.com/v1", responses: endpoint } : { baseURL: "https://api.openai.com/v1", chat: { completions: endpoint } }, {
          guardrails: { enabled: true, onError },
        })
        const output = await endpoint.create({ model: native.model, stream, orlune_metadata: { ...metadata, feature: "test" } })
        if (stream) {
          let chunks = 0
          for await (const chunk of output) { assert.ok(chunk); chunks++ }
          assert.equal(chunks, 2)
        } else assert.equal(output, native)
        await sdk.flush()
        assert.equal(checks, 1)
        assert.equal(providerCalls, 1)
        assert.equal(telemetry, 1)
        fetch.mock.restore()
      }
    }
  }
  assert.equal(warnings.mock.callCount(), 8)
  for (const call of warnings.mock.calls) {
    assert.match(call.arguments[0], /proceeding without policy evaluation/)
    assert.match(call.arguments[0], reasonCode === "NO_ACTIVE_POLICIES" ? /No active policies/ : /Evaluation limit exceeded/)
  }
})
}

test("malformed not-evaluated responses are still invalid responses", async t => {
  for (const invalid of [
    { ...quotaResult, reasonCode: "UNKNOWN" },
    { ...quotaResult, matchedRule: result("BLOCK").matchedRule },
    { ...quotaResult, matchedRule: undefined },
  ]) {
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(invalid))
    await assert.rejects(makeClient().evaluate(request), error => error instanceof OrluneEvaluationException && error.code === "INVALID_RESPONSE")
    fetch.mock.restore()
  }
})

test("direct evaluations reject missing or invalid activity IDs before sending a request", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { assert.fail("No HTTP request expected") })
  const sdk = makeClient()
  await assert.rejects(sdk.evaluate({ customerId: "customer" }), (error) =>
    error instanceof OrluneEvaluationException && error.code === "INVALID_REQUEST" && /activityId/.test(error.message))
  for (const activityId of [undefined, null, "", "   ", 123, "a".repeat(257)]) {
    await assert.rejects(sdk.evaluate({ ...request, activityId }), (error) =>
      error instanceof OrluneEvaluationException && error.code === "INVALID_REQUEST" && /activityId/.test(error.message))
  }
  assert.equal(fetch.mock.callCount(), 0)
})

test("blocked calls forward activity context without invoking the provider or sending usage", async (t) => {
  let providerCalls = 0
  const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(url.endsWith("/evaluate"))
    assert.deepEqual(JSON.parse(init.body), { ...request, activityType: "generate_campaign", activityName: "Summer campaign", prompt: "Write a campaign" })
    return Response.json(result("BLOCK"))
  })
  const endpoint = { async create() { providerCalls++; return response } }
  const sdk = makeClient()
  sdk.wrap({ baseURL: "https://api.openai.com/v1", responses: endpoint }, { guardrails: { enabled: true } })
  await assert.rejects(endpoint.create({ model: "gpt-4.1-mini", input: "Write a campaign", orlune_metadata: {
    ...metadata, feature: "summaries", activity: { id: "activity", type: "generate_campaign", name: "Summer campaign" },
  } }), OrluneGuardrailException)
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(providerCalls, 0)
})

test("wrapped blocked calls generate an activity ID without requiring a type or name", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(url.endsWith("/evaluate"))
    const body = JSON.parse(init.body)
    assert.match(body.activityId, /^[0-9a-f-]{36}$/)
    assert.equal(body.customerId, "customer")
    assert.equal(body.activityType, undefined)
    assert.equal(body.activityName, undefined)
    return Response.json(result("BLOCK"))
  })
  const endpoint = { create() { assert.fail("Blocked provider must not run") } }
  makeClient().wrap({ baseURL: "https://api.openai.com/v1", responses: endpoint }, { guardrails: { enabled: true } })
  await assert.rejects(endpoint.create({ model: response.model, orlune_metadata: {
    customerId: "customer", eventType: "MODEL_CALL",
  } }), OrluneGuardrailException)
  assert.equal(fetch.mock.callCount(), 1)
})

test("prompt extraction selects current user text only without changing provider input", () => {
  for (const family of ["OPENAI_CHAT_COMPLETIONS", "OPENAI_RESPONSES"]) {
    const key = family === "OPENAI_RESPONSES" ? "input" : "messages"
    const type = family === "OPENAI_RESPONSES" ? "input_text" : "text"
    const messages = [
      { role: "system", content: "trusted secret" },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: [{ type, text: "new question" }, { type: "input_image", image_url: "private" }, { type, text: "more text" }] },
      { type: "function_call_output", output: "tool output" },
    ]
    const input = { [key]: messages, instructions: "trusted instructions" }
    const original = structuredClone(input)
    assert.equal(extractOpenAIPrompt(input, family), "new question\nmore text")
    assert.deepEqual(input, original)
    assert.equal(extractOpenAIPrompt({ [key]: [...messages, { role: "user", content: [{ type: "input_image" }] }] }, family), undefined)
    assert.equal(extractOpenAIPrompt({ [key]: [{ role: "developer", content: "instructions" }] }, family), undefined)
    assert.equal(extractOpenAIPrompt({ [key]: [{ role: "user", content: "plain text" }] }, family), "plain text")
  }
  assert.equal(extractOpenAIPrompt({ input: "short input" }, "OPENAI_RESPONSES"), "short input")
})

test("explicit evaluation truncates oversized prompts without changing the original", async (t) => {
  const warning = t.mock.method(console, "warn", () => {})
  const bodies = []
  const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return Response.json(result())
  })
  await makeClient().evaluate({ ...request, prompt: "x".repeat(100_000) })
  const oversizedRequest = { ...request, prompt: "x".repeat(100_001) }
  await makeClient().evaluate(oversizedRequest)
  assert.equal(bodies[0].prompt.length, 100_000)
  assert.deepEqual(bodies[1], { ...request, prompt: "x".repeat(100_000) })
  assert.equal(oversizedRequest.prompt.length, 100_001)
  assert.equal(warning.mock.callCount(), 1)
  for (const prompt of [null, 123]) {
    await assert.rejects(makeClient().evaluate({ ...request, prompt }), (error) => error.code === "INVALID_REQUEST")
  }
  assert.equal(fetch.mock.callCount(), 2)
})

test("prompt truncation does not split a surrogate pair", async (t) => {
  t.mock.method(console, "warn", () => {})
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(JSON.parse(init.body).prompt, "x".repeat(99_999))
    return Response.json(result())
  })
  await makeClient().evaluate({ ...request, prompt: "x".repeat(99_999) + "\uD83D\uDE00tail" })
})

test("oversized wrapped prompts preserve OpenAI input and still enforce usage blocks", async (t) => {
  t.mock.method(console, "warn", () => {})
  for (const family of ["responses", "chat"]) {
    for (const decision of ["ALLOW", "BLOCK"]) {
      const prompt = "x".repeat(100_001)
      let providerCalls = 0
      const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
        if (url.endsWith("/evaluate")) {
          assert.equal(JSON.parse(init.body).prompt, prompt.slice(0, 100_000))
          return Response.json(result(decision))
        }
        return new Response(null, { status: 202 })
      })
      const endpoint = { async create(input) {
        providerCalls++
        assert.equal(family === "responses" ? input.input : input.messages[0].content, prompt)
        return response
      } }
      makeClient().wrap(family === "responses" ? { baseURL: "https://api.openai.com/v1", responses: endpoint } : { baseURL: "https://api.openai.com/v1", chat: { completions: endpoint } }, {
        guardrails: { enabled: true },
      })
      const pending = endpoint.create({ model: response.model, orlune_metadata: metadata,
        ...(family === "responses" ? { input: prompt } : { messages: [{ role: "user", content: prompt }] }) })
      if (decision === "BLOCK") await assert.rejects(pending, OrluneGuardrailException)
      else await pending
      assert.equal(providerCalls, decision === "BLOCK" ? 0 : 1)
      fetch.mock.restore()
    }
  }
})

test("prompt preflight preserves allow/block behavior for both APIs and streams", async (t) => {
  for (const family of ["responses", "chat"]) {
    for (const stream of [false, true]) {
      for (const reason of ["PROMPT_INJECTION_DETECTED", "INTENT_NOT_ALLOWED", "PROMPT_ANALYSIS_UNAVAILABLE"]) {
        const blocked = reason !== "PROMPT_ANALYSIS_UNAVAILABLE"
        const decision = { ...result(blocked ? "BLOCK" : "ALLOW"), reasonCode: reason,
          promptAnalysis: blocked ? { status: "completed", promptInjection: { detected: true } } : { status: "unavailable" } }
        let providerCalls = 0, telemetry = 0, checks = 0
        const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
          if (url.endsWith("/evaluate")) {
            checks++
            assert.equal(JSON.parse(init.body).prompt, "current user prompt")
            return Response.json(decision)
          }
          telemetry++
          return new Response(null, { status: 202 })
        })
        const input = { model: response.model, stream, orlune_metadata: metadata,
          ...(family === "responses" ? { input: "current user prompt" } : { messages: [{ role: "user", content: "current user prompt" }] }) }
        const endpoint = { async create(forwarded) {
          providerCalls++
          assert.equal(forwarded.orlune_metadata, undefined)
          assert.deepEqual(forwarded.input ?? forwarded.messages, input.input ?? input.messages)
          if (!stream) return response
          return (async function* () {})()
        } }
        makeClient().wrap(family === "responses" ? { baseURL: "https://api.openai.com/v1", responses: endpoint } : { baseURL: "https://api.openai.com/v1", chat: { completions: endpoint } }, {
          guardrails: { enabled: true, onError: "allow" },
        })
        if (blocked) {
          await assert.rejects(endpoint.create(input), (error) => error instanceof OrluneGuardrailException && error.reasonCode === reason)
          assert.equal(providerCalls, 0)
          assert.equal(telemetry, 0)
        } else {
          await endpoint.create(input)
          assert.equal(providerCalls, 1)
        }
        assert.equal(checks, 1)
        fetch.mock.restore()
      }
    }
  }
})

test("ALLOW with a triggered policy is returned and still permits the provider call", async (t) => {
  const allowed = { ...result("BLOCK"), decision: "ALLOW", reasonCode: "PROMPT_INJECTION_DETECTED",
    matchedRule: { id: "observe", name: "Observe injection", message: null } }
  let providerCalls = 0
  t.mock.method(globalThis, "fetch", async (url) => url.endsWith("/evaluate")
    ? Response.json(allowed) : new Response(null, { status: 202 }))
  const sdk = makeClient()
  assert.deepEqual(await sdk.evaluate(request), allowed)
  const endpoint = { async create() { providerCalls++; return response } }
  sdk.wrap({ baseURL: "https://api.openai.com/v1", responses: endpoint }, { guardrails: { enabled: true } })
  await endpoint.create({ model: response.model, input: "test", orlune_metadata: metadata })
  assert.equal(providerCalls, 1)
})

test("disabled guardrails do not send prompts or perform evaluations", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(!url.endsWith("/evaluate"))
    assert.ok(!init.body.includes("private user prompt"))
    return new Response(null, { status: 202 })
  })
  const endpoint = { async create() { return response } }
  makeClient().wrap({ baseURL: "https://api.openai.com/v1", responses: endpoint })
  await endpoint.create({ model: response.model, input: "private user prompt", orlune_metadata: metadata })
})

test("explicit evaluate sends only the contract and returns ALLOW or BLOCK without throwing", async (t) => {
  for (const decision of ["ALLOW", "BLOCK"]) {
    const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.ok(url.endsWith("/v1/guardrails/evaluate"))
      assert.equal(init.headers.authorization, "Bearer key")
      assert.deepEqual(JSON.parse(init.body), request)
      return Response.json(result(decision))
    })
    assert.deepEqual(await makeClient().evaluate({ ...request, applicationId: "not-sent" }), result(decision))
    assert.equal(fetch.mock.callCount(), 1)
    fetch.mock.restore()
  }
})

test("both provider families check before calls, strip metadata and share activity with telemetry", async (t) => {
  for (const family of ["responses", "chat"]) {
    const order = []
    const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
      const body = JSON.parse(init.body)
      if (url.endsWith("/evaluate")) {
        order.push("evaluate")
        assert.deepEqual(body, { ...request, activityType: "summaries" })
        return Response.json(result())
      }
      order.push("telemetry")
      assert.equal(body.event.operation.id, request.activityId)
      return new Response(null, { status: 202 })
    })
    const endpoint = { async create(input, options) {
      order.push("provider")
      assert.equal(input.orlune_metadata, undefined)
      assert.equal(options.custom, "preserved")
      return response
    } }
    const provider = family === "responses" ? { baseURL: "https://api.openai.com/v1", responses: endpoint } : { baseURL: "https://api.openai.com/v1", chat: { completions: endpoint } }
    const sdk = makeClient()
    sdk.wrap(provider, { defaults: { feature: "old" }, guardrails: { enabled: true } })
    assert.equal(await endpoint.create({ model: "gpt-4.1-mini", orlune_metadata: { ...metadata, feature: "summaries" } }, { custom: "preserved" }), response)
    assert.deepEqual(order, ["evaluate", "provider", "telemetry"])
    fetch.mock.restore()
  }
})

test("BLOCK throws the typed exception and never calls provider or writes usage, including streams", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(result("BLOCK")))
  for (const family of ["responses", "chat"]) {
    for (const stream of [false, true]) {
      let calls = 0
      const endpoint = { create() { calls++; throw new Error("Should not run") } }
      const sdk = makeClient()
      sdk.wrap(family === "responses" ? { baseURL: "https://api.openai.com/v1", responses: endpoint } : { baseURL: "https://api.openai.com/v1", chat: { completions: endpoint } }, {
        guardrails: { enabled: true, onError: "allow" },
      })
      await assert.rejects(endpoint.create({ stream, orlune_metadata: metadata }), (error) => {
        assert.ok(error instanceof OrluneGuardrailException)
        assert.equal(error.message, "Daily budget reached")
        assert.equal(error.matchedRule.id, "rule")
        assert.equal(error.evaluationId, "evaluation-1")
        assert.equal(error.details.observedValue, 101)
        return true
      })
      await sdk.flush()
      assert.equal(calls, 0)
    }
  }
  assert.equal(fetch.mock.callCount(), 4)
})

test("stream checks once before opening, not on each chunk", async (t) => {
  let checks = 0
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/evaluate")) { checks++; return Response.json(result()) }
    return new Response(null, { status: 202 })
  })
  const endpoint = { async create() {
    assert.equal(checks, 1)
    return (async function* () {
      yield { type: "response.output_text.delta", delta: "Hello" }
      yield { type: "response.output_text.delta", delta: " world" }
      yield { type: "response.completed", response }
    })()
  } }
  makeClient().wrap({ baseURL: "https://api.openai.com/v1", responses: endpoint }, { guardrails: { enabled: true } })
  const stream = await endpoint.create({ stream: true, model: response.model, orlune_metadata: metadata })
  let chunks = 0
  for await (const chunk of stream) { chunks++ }
  assert.equal(chunks, 3)
  assert.equal(checks, 1)
})

test("evaluation errors stop calls by default; explicit fail-open allows provider and telemetry", async (t) => {
  t.mock.method(console, "warn", () => {})
  let evaluations = 0, telemetry = 0, providerCalls = 0
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/evaluate")) { evaluations++; return new Response(null, { status: 503 }) }
    telemetry++; return new Response(null, { status: 202 })
  })
  for (const onError of ["throw", "allow"]) {
    const endpoint = { async create() { providerCalls++; return response } }
    makeClient().wrap({ baseURL: "https://api.openai.com/v1", responses: endpoint }, { guardrails: { enabled: true, onError } })
    const call = endpoint.create({ model: response.model, orlune_metadata: metadata })
    if (onError === "throw") await assert.rejects(call, (error) => error instanceof OrluneEvaluationException && error.status === 503)
    else await call
  }
  assert.equal(evaluations, 2)
  assert.equal(providerCalls, 1)
  assert.equal(telemetry, 1)
})

test("invalid metadata never fails open and malformed responses never become an allow", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ decision: "ALLOW" }))
  const endpoint = { create() { assert.fail("provider should not run") } }
  const sdk = makeClient()
  sdk.wrap({ baseURL: "https://api.openai.com/v1", responses: endpoint }, { guardrails: { enabled: true, onError: "allow" } })
  await assert.rejects(endpoint.create({}), (error) => error.code === "INVALID_REQUEST")
  await assert.rejects(endpoint.create(), (error) => error.code === "INVALID_REQUEST")
  assert.equal(fetch.mock.callCount(), 0)
  await assert.rejects(sdk.evaluate(request), (error) => error.code === "INVALID_RESPONSE")
})

test("HTTP errors preserve backend validation messages without changing their error code", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({
    error: { code: "INVALID_REQUEST", message: "Provide customerId and activityId. Feature is optional." },
  }, { status: 400 }))
  await assert.rejects(makeClient().evaluate(request), (error) => {
    assert.equal(error.code, "HTTP_ERROR")
    assert.equal(error.status, 400)
    assert.match(error.message, /Provide customerId/)
    return true
  })
  assert.equal(fetch.mock.callCount(), 1)
})

test("timeout and cancellation are typed and no automatic retries occur", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
  }))
  const sdk = makeClient({ evaluationTimeoutMs: 10 })
  await assert.rejects(sdk.evaluate(request), (error) => error.code === "TIMEOUT")
  const controller = new AbortController()
  const pending = sdk.evaluate(request, { signal: controller.signal, timeoutMs: 1000 })
  controller.abort()
  await assert.rejects(pending, (error) => error.code === "ABORTED")
  await assert.rejects(sdk.evaluate(request, { signal: controller.signal }), (error) => error.code === "ABORTED")
  assert.equal(fetch.mock.callCount(), 2)
})

test("provider cancellation during preflight prevents execution even with fail-open", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
  }))
  const endpoint = { create() { assert.fail("provider should not run") } }
  makeClient().wrap({ baseURL: "https://api.openai.com/v1", responses: endpoint }, { guardrails: { enabled: true, onError: "allow" } })
  const controller = new AbortController()
  const call = endpoint.create({ orlune_metadata: metadata }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(call, (error) => error.code === "ABORTED")
})

test("guardrails cannot be silently enabled on an already wrapped client", () => {
  const sdk = makeClient()
  const provider = sdk.wrap({ baseURL: "https://api.openai.com/v1", responses: { async create() { return response } } })
  assert.throws(() => sdk.wrap(provider, { guardrails: { enabled: true } }), /already wrapped/)
})

test("background telemetry still awaits evaluation and reuses the generated activity ID", async (t) => {
  let finishCheck
  let evaluationRequest
  let telemetryRequest
  let providerCalls = 0
  t.mock.method(globalThis, "fetch", (url, init) => {
    if (url.endsWith("/evaluate")) {
      evaluationRequest = JSON.parse(init.body)
      return new Promise((resolve) => { finishCheck = () => resolve(Response.json(result())) })
    }
    telemetryRequest = JSON.parse(init.body)
    return Promise.resolve(new Response(null, { status: 202 }))
  })
  const sdk = makeClient({ telemetryDelivery: { mode: "background_flush", flushIntervalMs: 60000 } })
  const endpoint = { async create() { providerCalls++; return response } }
  sdk.wrap({ baseURL: "https://api.openai.com/v1", responses: endpoint }, { defaults: { feature: "summaries" }, guardrails: { enabled: true } })
  const pending = endpoint.create({ model: response.model, orlune_metadata: { customerId: "customer", eventType: "MODEL_CALL" } })
  assert.equal(providerCalls, 0)
  assert.ok(evaluationRequest.activityId)
  finishCheck()
  await pending
  assert.equal(providerCalls, 1)
  assert.equal(telemetryRequest, undefined)
  await sdk.flush()
  assert.equal(telemetryRequest.event.operation.id, evaluationRequest.activityId)
})
