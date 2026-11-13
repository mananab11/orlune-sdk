# Orlune SDK

Track AI usage and cost by customer, feature, and activity. Optionally check Orlune guardrail policies before calling your AI provider.

Wrap your existing OpenAI or Anthropic client, then add business context to each request. Orlune removes its metadata before forwarding the request to the provider.

## Install

Requires **Node.js 22+**. Use this package on your server, never in browser code. It provides ESM imports; CommonJS applications can use dynamic `import()`.

Install Orlune and your chosen provider SDK:

```sh
# OpenAI
npm install orlune openai

# Anthropic
npm install orlune @anthropic-ai/sdk
```

Create an API key in your Orlune application's **API Keys** page. Set `ORLUNE_API_KEY` and your provider's key in your server environment. Keep both secret.

## Quick Start

Choose the example for your provider. These examples track usage; guardrails are disabled until you explicitly enable them.

### OpenAI

Set `ORLUNE_API_KEY` and `OPENAI_API_KEY`, then:

```ts
import { randomUUID } from "node:crypto"
import OpenAI from "openai"
import { OrluneClient } from "orlune"

const orlune = OrluneClient({ apiKey: process.env.ORLUNE_API_KEY! })
const openai = orlune.wrap(new OpenAI())

const response = await openai.responses.create({
  model: "gpt-4.1-mini",
  input: "Write a short product description for a travel backpack.",
  orlune_metadata: {
    customerId: "customer-123",
    feature: "Product descriptions",
    eventType: "GENERATE_DESCRIPTION",
    activity: { id: randomUUID(), type: "create_product_listing" },
  },
})

console.log(response.output_text)
```

`openai.chat.completions.create()` accepts the same `orlune_metadata` object alongside its normal provider parameters.

### Anthropic

Set `ORLUNE_API_KEY` and `ANTHROPIC_API_KEY`, then:

```ts
import { randomUUID } from "node:crypto"
import Anthropic from "@anthropic-ai/sdk"
import { OrluneClient } from "orlune"

const orlune = OrluneClient({ apiKey: process.env.ORLUNE_API_KEY! })
const anthropic = orlune.wrap(new Anthropic())

const message = await anthropic.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Write a short product description for a travel backpack." }],
  orlune_metadata: {
    customerId: "customer-123",
    feature: "Product descriptions",
    eventType: "GENERATE_DESCRIPTION",
    activity: { id: randomUUID(), type: "create_product_listing" },
  },
})

for (const block of message.content) {
  if (block.type === "text") console.log(block.text)
}
```

Use a model available to your provider account. Orlune does not bundle either provider SDK.

## Request Metadata

Every wrapped call requires `orlune_metadata`:

| Field | Required | Meaning | Maximum length |
| --- | --- | --- | --- |
| `customerId` | Yes | Your application's identifier for the customer making the request. | 256 characters |
| `eventType` | Yes | The operation this individual AI call performs, such as `GENERATE_DESCRIPTION`. | 128 characters |
| `activity.id` | Yes | An identifier that groups calls belonging to one workflow. | 256 characters |
| `activity.type` | Yes | The workflow name, such as `create_product_listing`. | 128 characters |
| `feature` | No | The product feature to attribute usage to, such as `Product descriptions`. | 256 characters |

Use your own strings for these values. Required values cannot be blank. Invalid metadata throws **before calling the provider**, even when guardrails are disabled.

For a single call, generate an activity ID with `randomUUID()`. For a workflow with several calls, generate it **once** and reuse the same activity ID and type across those calls. For example, generating a title and a description can share one activity, with different `eventType` values. Orlune does not generate activity IDs for you.

You can set a default feature when wrapping:

```ts
const openai = orlune.wrap(new OpenAI(), {
  defaults: { feature: "Product descriptions" },
})
```

A per-call `feature` overrides that default. If neither is set, telemetry uses `UNKNOWN`, and named feature-specific guardrails will not match. Only `feature` supports a wrapper default; customer, event type, and activity belong on each call.

## Streaming

Use your provider's normal streaming API and consume the stream:

```ts
const stream = await openai.responses.create({
  model: "gpt-4.1-mini",
  input: "Write a short product description.",
  stream: true,
  orlune_metadata: {
    customerId: "customer-123",
    eventType: "GENERATE_DESCRIPTION",
    activity: { id: randomUUID(), type: "create_product_listing" },
  },
})

for await (const event of stream) {
  if (event.type === "response.output_text.delta") {
    process.stdout.write(event.delta)
  }
}
```

The `openai` client and `randomUUID` above come from the quick start.

Orlune observes usage as chunks pass through and sends **one terminal telemetry event**, not one event per chunk. Chat Completions automatically enables `stream_options.include_usage`. If a stream ends without final usage, usage may be unavailable rather than estimated.

Anthropic supports both `messages.create({ stream: true, ... })` and `messages.stream(...)`. Supply the same metadata to either. The native `messages.stream()` helper keeps its type inference; required metadata is checked at runtime rather than enforced by its TypeScript signature. Await its `finalMessage()` or handle its errors through the native stream API.

## Enable Guardrails

Configure policies in Orlune, then enable checks when you first wrap the provider client:

```ts
import { GuardrailErrorMode } from "orlune"

const openai = orlune.wrap(new OpenAI(), {
  guardrails: {
    enabled: true,
    onError: GuardrailErrorMode.Throw,
    timeoutMs: 5000,
  },
})
```

Use this in place of the quick start's `wrap()` call. The same options work with Anthropic.

Orlune checks **once before each provider invocation**, including streamed calls. It does not check each output chunk.

| Outcome | What happens |
| --- | --- |
| Policy blocks the request | The provider is not called. Throws `OrluneGuardrailException`. |
| Request is allowed | The provider is called normally. |
| Evaluation fails or times out; `GuardrailErrorMode.Throw` | The provider is not called. Throws `OrluneEvaluationException`. This is the default. |
| Evaluation fails or times out; `GuardrailErrorMode.Allow` | Logs a warning and proceeds without a completed check. |
| No active policies or evaluation allowance exhausted | Logs a warning and proceeds. The API returns `NOT_EVALUATED`, not an evaluation error. |

`GuardrailErrorMode.Allow` never overrides a policy block, invalid evaluation input, or caller cancellation.

### Handle Errors

Wrap your provider call in your application's error handling:

```ts
import { OrluneGuardrailException, OrluneEvaluationException } from "orlune"

try {
  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: "Write a product description.",
    orlune_metadata: {
      customerId: "customer-123",
      eventType: "GENERATE_DESCRIPTION",
      activity: { id: randomUUID(), type: "create_product_listing" },
    },
  })
  console.log(response.output_text)
} catch (error) {
  if (error instanceof OrluneGuardrailException) {
    // No provider call was made. The message uses your policy's configured response.
    console.log(error.message, error.matchedRule.name, error.evaluationId)
  } else if (error instanceof OrluneEvaluationException) {
    // Evaluation failed, was cancelled, or received invalid input.
    console.error(error.code, error.status)
  } else {
    throw error // Preserve the original provider error.
  }
}
```

### What Is Checked

Usage policies check recorded usage, not a reservation for the next request. They are not an atomic spending cap.

Prompt policies analyze the latest user message's text. System instructions, earlier turns, tool results, images, and audio are not analyzed. No user text means prompt analysis is skipped; usage policies can still run.

Prompt checks send text to Orlune and its analysis provider. Only the first 100,000 UTF-16 code units are analyzed, without splitting a surrogate pair. The original provider input is unchanged; omitted text is not checked.

An analysis-provider failure can return an allowed result from the backend unless another policy blocks the request. This is separate from `onError`, which controls failures reaching or receiving a valid response from the evaluation API.

### Check Without Wrapping

For explicit control, call the evaluator directly:

```ts
const result = await orlune.evaluate({
  customerId: "customer-123",
  activityId: randomUUID(),
  activityType: "create_product_listing",
  feature: "Product descriptions", // Optional.
  prompt: "Write a product description.", // Optional for usage-only checks.
})

if (result.decision === "BLOCK") {
  console.log(result.matchedRule.message)
} else if (result.decision === "NOT_EVALUATED") {
  console.warn(result.reasonCode)
}
```

Direct evaluation returns `ALLOW`, `BLOCK`, or `NOT_EVALUATED`; API failures throw `OrluneEvaluationException`. Your application decides whether to proceed. Use `decision`, not the presence of `matchedRule`: an allowed result can include a nonblocking detection.

Reuse the activity ID in subsequent provider calls to group them with the decision. Avoid combining an explicit check with automatic guardrails for the same call unless you want two evaluations.

## Telemetry Delivery

Telemetry is best-effort. Delivery or capture failures do not replace provider responses or exceptions. If capture fails, the request may be missing from Orlune. Guardrail blocks and metadata validation remain separate.

| Mode | Behavior |
| --- | --- |
| `TelemetryMode.Sync` | Default. Waits for the telemetry send attempt before returning the response or finishing the stream. Can add latency. |
| `TelemetryMode.BackgroundFlush` | Queues telemetry in memory and sends it in the background. Does not wait for the network send on the provider response path. |

To use background delivery:

```ts
import { OrluneClient, TelemetryMode } from "orlune"

const orlune = OrluneClient({
  apiKey: process.env.ORLUNE_API_KEY!,
  telemetryDelivery: { mode: TelemetryMode.BackgroundFlush },
})

// Before a serverless handler or CLI exits, or during graceful server shutdown:
await orlune.flush()
```

Call `flush()` **after your provider work**, typically in a `finally` block. It waits for queued attempts and retries, but does not guarantee delivery. Abrupt process termination can lose queued events. A full queue drops its oldest waiting event and logs an error.

### Configuration Reference

| Option | Default | Purpose |
| --- | --- | --- |
| `apiKey` | Required | Your Orlune API key. |
| `telemetryDelivery.mode` | `TelemetryMode.Sync` | Delivery mode. |
| `telemetryDelivery.timeoutMs` | `5000` | Timeout for each telemetry send attempt. |
| `telemetryDelivery.flushIntervalMs` | `1000` | Background-only interval between scheduled flushes. |
| `telemetryDelivery.maxQueueSize` | `500` | Background-only maximum waiting events. |
| `telemetryDelivery.maxRetries` | `2` | Background-only retries after the initial send fails. |
| `evaluationTimeoutMs` | `5000` | Default evaluation timeout. |
| `baseURL` | Orlune production | Optional override for a different Orlune deployment. |

A wrap-level `guardrails.timeoutMs` or direct `evaluate(request, { timeoutMs, signal })` call overrides the default evaluation timeout. Provider request cancellation signals also apply during automatic preflight. These timeouts do not set the provider's own timeout.

`baseURL` must be an HTTPS origin without a path, credentials, query, or fragment. HTTP is allowed for localhost testing. The override applies to both telemetry and evaluation.

## Supported APIs and Limits

| Provider | Supported calls |
| --- | --- |
| OpenAI | `responses.create()`, `chat.completions.create()`; streamed and non-streamed. |
| Anthropic | `messages.create()`; streamed and non-streamed, plus `messages.stream()`. |

- Direct OpenAI and Anthropic endpoints are supported. Clients targeting custom proxies, Azure, Bedrock, Vertex, or other providers are rejected.
- The SDK currently targets text-token usage. Do not assume complete image, audio, or other modality pricing.
- `await` and `.withResponse()` collect telemetry. Using only `.asResponse()` leaves the raw response body with you and does not collect usage; enabled guardrails still run.
- OpenAI Responses that are still `queued` or `in_progress` are not recorded as completed requests. Orlune does not poll for background completion.
- Batch APIs, beta namespaces, and tool runners are not instrumented. Tools supplied to supported calls remain the provider's responsibility.
- `wrap()` modifies the supplied client. Configure it once and use a separate provider client if you need different settings or an unwrapped client.

## Contributing

```sh
npm ci
npm run check
npm test
npm run test:package
```

The package check builds and installs a tarball in an isolated project, then checks imports, public types, and telemetry. CI is configured for Node.js 22 and 24.
