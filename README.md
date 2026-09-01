# Orlune SDK

TypeScript SDK for sending AI usage events to the Orlune ingestion API.

## Status

Current v1 support:

- wraps an existing OpenAI client
- supports `responses.create(...)`
- supports `chat.completions.create(...)`
- supports streamed and non-streamed calls for both APIs
- sends usage telemetry to Orlune
- keeps provider call behavior unchanged
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
  },
})
```

`telemetryDelivery.mode` currently supports:

- `sync`
- `background_flush`

`background_flush` queues telemetry in memory and drains it on an interval.

For short-lived runtimes such as serverless functions, CLI jobs, or controlled shutdown paths, call:

```ts
await orlune.flush()
```

That is the delivery guarantee point for queued telemetry.

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
- current transport target is the production ingestion endpoint
- `sandbox` environment is not configured yet
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
