# Orlune SDK

TypeScript SDK for sending AI usage events to the Orlune ingestion API.

## Status

Current v1 support:

- wraps an existing OpenAI client
- supports `responses.create(...)`
- supports `chat.completions.create(...)`
- supports streamed and non-streamed calls for both APIs
- sends usage telemetry to Orlune
- keeps provider call behavior unchanged unless guardrails are explicitly enabled
- supports explicit evaluation and automatic preflight guardrail checks
- supports `sync` and `background_flush` delivery modes
- supports `orlune.flush()` for short-lived runtimes and graceful shutdown

## Install

This package is currently local to the repository. It is intended to be safe to publish and use for OpenAI text telemetry.

## Create Client

```ts
import { OrluneClient } from "orlune"

const orlune = OrluneClient({
  apiKey: "your-api-key",
  environment: "production",
  telemetryDelivery: {
    mode: "background_flush",
    flushIntervalMs: 1000,
    maxQueueSize: 500,
    maxRetries: 2,
    timeoutMs: 5000,
  },
})
```

`environment` selects the endpoint explicitly; it is not inferred from the API key:

| Environment | API base |
| --- | --- |
| `production` | `https://dx02lonqo8.execute-api.us-east-1.amazonaws.com` |
| `development` | `https://tcum999ahg.execute-api.us-east-1.amazonaws.com` |
| `sandbox` | `https://du37zudv2g.execute-api.us-west-2.amazonaws.com` |

Telemetry uses `/v1/events`; preflight policy checks use `/v1/guardrails/evaluate` on the same base. Use `environment: "development"` for the development API. The demo uses `environment: "production"`.

`telemetryDelivery.mode` currently supports:

- `sync`
- `background_flush`

`background_flush` queues telemetry in memory and drains it on an interval.

`telemetryDelivery.timeoutMs` defaults to 5,000 ms in both modes and limits each
telemetry send attempt. It does not limit OpenAI calls or guardrail evaluations.
In `sync` mode, a telemetry timeout does not fail the provider call. Background
sends retry according to `maxRetries`; `flush()` can therefore take longer than
one timeout when retries or multiple queued events are involved.

Non-streaming Responses with `failed`, `incomplete`, or `cancelled` status retain
reported usage and their outcome. Responses still `queued` or `in_progress`
are not recorded as completed requests; the SDK warns rather than tracking
background completion through polling.

For short-lived runtimes such as serverless functions, CLI jobs, or controlled shutdown paths, call:

```ts
await orlune.flush()
```

This waits for queued delivery attempts, including retries. Delivery remains
best-effort: delivery failures and dropped events are logged with `console.error`
without changing provider results or exceptions. Queue size and flush interval
must be positive safe integers; the interval cannot exceed 2,147,483,647 ms.
Retries must be a non-negative safe integer. Retry delays are capped at 30 seconds.

## Guardrails

Guardrails are opt-in. Existing wrapped clients only track telemetry unless you
enable preflight checks when first wrapping the provider client:

```ts
import OpenAI from "openai"
import { OrluneGuardrailException, OrluneEvaluationException } from "orlune"

const openai = orlune.wrap(new OpenAI(), {
  defaults: { feature: "summaries" },
  guardrails: { enabled: true, onError: "throw", timeoutMs: 5000 },
})

const input = {
  model: "gpt-4.1-mini",
  input: "Summarize this document.",
  orlune_metadata: {
    customerId: "customer-123",
    eventType: "MODEL_CALL",
    activity: { id: "activity-123" },
  },
}

try {
  const response = await openai.responses.create(input)
} catch (error) {
  if (error instanceof OrluneGuardrailException) {
    // Provider was not called. Use the configured message in your application.
    console.log(error.message, error.evaluationId, error.matchedRule, error.details)
  } else if (error instanceof OrluneEvaluationException) {
    // Check unavailable or input invalid; this is not a guardrail denial.
    console.error(error.code, error.status)
  } else {
    throw error // Original provider error.
  }
}
```

The SDK merges defaults and call metadata, checks guardrails, and only then calls
the provider. `customerId` is required for guarded calls. `feature` and activity
ID are optional; wrapped calls generate an activity ID when absent and reuse it
for evaluation and telemetry. Provider timing excludes preflight latency.

With guardrails enabled, the SDK also sends the latest user message's text to
Orlune for configured prompt injection and allowed-intent policies. Responses
string input and text content parts in both APIs are supported. System/developer
instructions, earlier turns, tool outputs, images, and audio are not analyzed.
Server-side conversation history referenced by `previous_response_id` is not fetched.
When there is no user text, usage checks still run but prompt analysis is skipped.
Prompts exceeding 100,000 UTF-16 code units are truncated to that limit for
evaluation, without splitting surrogate pairs, with a warning. Only the beginning
is analyzed; threats in the omitted text will not be detected. Usage checks still
run, and the original input sent to OpenAI is unchanged.
This is a character limit, not a token limit. Prompt checks
send text to Orlune's analysis provider; enable guardrails only where this is
appropriate for your application's data handling requirements.

A prompt-analysis provider failure currently returns `ALLOW` from the backend
(unless a usage policy already blocked), with `PROMPT_ANALYSIS_UNAVAILABLE`.
This is separate from the SDK's `onError` handling for evaluation API failures.

When the organization's evaluation allowance and buffer are exhausted, the API
returns HTTP 200 with `decision: "NOT_EVALUATED"`,
`reasonCode: "EVALUATION_LIMIT_EXCEEDED"`, and `matchedRule: null`. This is neither
an allow decision nor an API failure. Wrapped calls log a warning and continue to
the provider, including with `onError: "throw"`; normal telemetry still runs.
With no active policies, the API also returns `NOT_EVALUATED`, with
`reasonCode: "NO_ACTIVE_POLICIES"`. Wrapped calls warn and proceed in this case too.
Both skipped results are recorded asynchronously in Decisions and the activity
timeline. They do not create alerts, send notifications, mark an activity as
blocked, or consume evaluation allowance. Direct callers receive the result and
choose how to handle unchecked requests.

Both supported OpenAI APIs check once per invocation. Streaming calls check
before opening the stream, never for each chunk. Blocked calls do not emit fake
provider usage or failure events; the backend records the evaluation separately.
When an activity ID is present, the backend also creates a blocked activity
with zero usage if that activity does not already exist. Existing activities
are preserved. This happens asynchronously, so it may appear after the decision.

`onError` defaults to `"throw"`. Explicit `"allow"` proceeds with a console warning
when evaluation fails, including HTTP errors or invalid server responses. It
never overrides a `BLOCK`, missing/invalid customer metadata, or cancellation.
Use this option only if allowing unchecked calls during failures is acceptable.

### Explicit checks

```ts
const result = await orlune.evaluate({
  customerId: "customer-123",
  feature: "summaries",
  activityId: "activity-123",
  activityType: "generate_summary", // Optional; defaults to feature in the backend.
  activityName: "Weekly summary", // Optional display name.
  prompt: "Summarize this report", // Optional; omit for usage-only evaluation.
}, { timeoutMs: 5000, signal: abortController.signal })

if (result.decision === "BLOCK") {
  console.log(result.matchedRule.message, result.reasonCode)
} else if (result.decision === "NOT_EVALUATED") {
  console.warn("Policies were not evaluated:", result.reasonCode)
  // Decide whether your application should continue without protection.
}
```

Direct evaluation returns `ALLOW`, `BLOCK`, or `NOT_EVALUATED` rather than throwing
for these outcomes.
Both `customerId` and `activityId` are required for direct checks. Reuse that
activity ID in subsequent calls to group their decisions and usage together.
Wrapped calls forward their resolved activity ID, type, and optional name
automatically, generating an activity ID when none is supplied. Activity type
and name remain optional.
An `ALLOW` can include `matchedRule` when a policy detected a violation without
blocking. It identifies the last triggered policy; a `BLOCK` identifies the first
blocking policy. Always use `decision`, not the presence of `matchedRule`, to
decide whether to proceed.
Errors throw `OrluneEvaluationException` with a `code` of `INVALID_REQUEST`,
`TIMEOUT`, `ABORTED`, `HTTP_ERROR`, `NETWORK_ERROR`, or `INVALID_RESPONSE`.
HTTP errors also include `status`.

Set `evaluationTimeoutMs` when creating `OrluneClient` to change the default
5-second timeout. A wrap-level or evaluate-call `timeoutMs` overrides it.
Wrapped calls also honor the provider request options' `signal` during preflight.
The timeout covers evaluation only, not the provider call.

Evaluation always waits for the server, even with `background_flush` telemetry.
It does not use the telemetry queue or retries. Each evaluation creates a new
check, so avoid explicitly evaluating and automatically evaluating the same call
unless you want two checks. Configure guardrails on the first `wrap()` call.
Wrapping again with the same Orlune client and unchanged settings is safe.
A different Orlune client or changed settings throws immediately at `wrap()`,
not during provider calls. Wrap settings are copied at initialization.

Checks use recorded usage, not a budget reservation or an estimate of the next
request. An `ALLOW` does not guarantee that subsequent usage stays below a limit.

## Wrap Existing OpenAI Client

```ts
import OpenAI from "openai"

const rawOpenAI = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

const openai = orlune.wrap(rawOpenAI, {
  defaults: {
    feature: "Suggestions generation",
    activity: {
      type: "draft_message",
      name: "Draft message",
    },
  },
})
```

Only the client initialization changes. Your existing provider calls stay the same.

Automatic detection currently supports OpenAI API endpoints (`api.openai.com`
and its subdomains). Clients targeting custom proxies, Azure, or other providers
are rejected rather than silently attributing their usage to OpenAI. Compatible
method names alone are not enough to identify a provider.

## Track A Single Invocation

Per-call metadata is passed inside `orlune_metadata`.

```ts
await openai.responses.create({
  model: "gpt-4.1-mini",
  input: "Hello",
  orlune_metadata: {
    customerId: "customer_123",
    eventType: "MODEL_CALL",
  },
})
```

The SDK strips `orlune_metadata` before forwarding the request to OpenAI.

The returned client's supported `create()` methods accept this metadata in
TypeScript without casts, while retaining provider parameter validation and
streaming return types. Other methods retain their original types.

### OpenAI Response Helpers

Normal `await`, `.then()`, `.catch()`, `.finally()`, and `.withResponse()` share
one provider invocation and one telemetry lifecycle. Guardrails run before the
provider call, including when using `.asResponse()`.

```ts
const { data, response, request_id } = await openai.responses.create({
  model: "gpt-4.1-mini",
  input: "Hello",
  orlune_metadata: { customerId: "customer_123", eventType: "MODEL_CALL" },
}).withResponse()
```

`.asResponse()` returns the raw HTTP response without reading its body. Using
only that method does not collect usage telemetry; use `await` or
`.withResponse()` for tracked calls. For streamed calls, consume the returned
stream to collect its final usage. A stream remains single-consumption even if
you access the same call through more than one promise helper.

Metadata-aware method types and promise observation are reusable across provider
adapters. Runtime provider support remains OpenAI only; adding a provider still
requires its detection, method interception, and usage mapping adapter.

Provider adapters own their client matching, intercepted method paths, promise
helpers, prompt extraction, and result/stream interpretation. Shared code handles
metadata extraction and the single-invocation observation lifecycle without
assuming OpenAI response fields or helper names. Register new adapters in
`src/providers/get-provider-adapter.ts` and their public client types in
`src/providers/provider-client-types.ts`.

## Streaming

The same wrapped client works for streamed calls.

Responses API:

```ts
const stream = await openai.responses.create({
  model: "gpt-4.1-mini",
  input: "Hello",
  stream: true,
  orlune_metadata: {
    customerId: "customer_123",
    eventType: "MODEL_STREAM",
  },
})

for await (const event of stream) {
  void event
}
```

Chat Completions API:

```ts
const stream = await openai.chat.completions.create({
  model: "gpt-4.1-mini",
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
  orlune_metadata: {
    customerId: "customer_123",
    eventType: "CHAT_STREAM",
  },
})

for await (const chunk of stream) {
  void chunk
}
```

Streaming behavior:

- the SDK does not emit telemetry for intermediate chunks
- it emits one terminal event when the stream completes
- if the stream is canceled or throws, it emits one terminal non-success event instead
- for Chat Completions, the SDK enables `stream_options.include_usage = true` automatically

## Stitch Multiple Calls Into One Activity

If you want multiple model invocations to roll up into one activity in Orlune, pass the same `activity.id` across calls.

```ts
const activityId = "activity_support_reply_123"

await openai.responses.create({
  model: "gpt-4.1-mini",
  input: "Gather context",
  orlune_metadata: {
    customerId: "customer_123",
    eventType: "MODEL_CALL",
    activity: {
      id: activityId,
      type: "respond_to_ticket",
      name: "Respond to ticket",
    },
  },
})

await openai.responses.create({
  model: "gpt-4.1-mini",
  input: "Draft final reply",
  orlune_metadata: {
    customerId: "customer_123",
    eventType: "MODEL_CALL",
    activity: {
      id: activityId,
      type: "respond_to_ticket",
      name: "Respond to ticket",
    },
  },
})
```

Both requests will be tied together in the backend under the same internal operation record.

## Standalone Activity Behavior

If you do not provide an `activity.id`, the SDK generates one automatically.

That means:

- every invocation is still tracked
- each invocation becomes its own standalone activity
- you only need to provide an `activity.id` when you want stitching

## Metadata Rules

Wrapper-level `defaults` acts as stable defaults.

Per-call `orlune_metadata` supplies invocation-level metadata and overrides wrapper defaults where applicable.

Example:

```ts
const openai = orlune.wrap(rawOpenAI, {
  defaults: {
    feature: "Research mode",
  },
})

await openai.responses.create({
  model: "gpt-4.1-mini",
  input: "Research this topic",
  orlune_metadata: {
    customerId: "customer_456",
    eventType: "MODEL_CALL",
    feature: "Summaries",
  },
})
```

The effective metadata for that request uses:

- `customerId = customer_456`
- `feature = Summaries`
- `eventType = MODEL_CALL`

## What The SDK Derives Internally

The caller provides business context:

- `customerId`
- `eventType`
- `feature` or wrapper default feature
- optional `activity.id`
- optional `activity.type`
- optional `activity.name`

`customerId` and `eventType` are required per invocation.

`feature` can be provided once in `defaults` or per invocation in `orlune_metadata`.

If `customerId` or `eventType` is missing, the SDK skips telemetry for that invocation and logs a warning with `console.warn(...)`.

If effective `feature` is missing, the SDK falls back to `"UNKNOWN"` and logs a warning.

The SDK derives runtime fields:

- request status
- activity/operation status
- started and completed timestamps
- provider request id
- model
- provider usage payload

## Current Limits

- provider support today is OpenAI only
- transport target is selected by the configured production, development, or sandbox environment
- telemetry failures do not change provider call behavior
- the SDK is currently intended for OpenAI text telemetry only
- if a streamed request ends without final usage from the provider, the backend may ingest the request with zero cost data

## Shutdown Guidance

Recommended usage:

- long-lived server: use `background_flush`, and call `await orlune.flush()` during graceful shutdown
- short-lived function or CLI: use `background_flush`, and call `await orlune.flush()` before returning or exiting
- strictest delivery semantics: use `sync`

## Development

Build:

```bash
npm run build
```

Typecheck:

```bash
npm run check
```

Tests:

```bash
npm test
```
