# Orlune SDK

TypeScript SDK for sending AI usage events to the Orlune ingestion API.

## Status

Current v1 support:

- wraps an existing OpenAI client
- supports `responses.create(...)`
- supports `chat.completions.create(...)`
- sends usage telemetry to Orlune
- keeps provider call behavior unchanged

## Install

This package is currently local to the repository. Publishing can be added later.

## Create Client

```ts
import { createClient } from "orlune"

const orlune = createClient({
  apiKey: "your-api-key",
  environment: "production",
  telemetryDelivery: {
    mode: "sync",
  },
})
```

`telemetryDelivery.mode` currently supports:

- `sync`

`manual_flush` and `background_flush` are reserved for later.

## Wrap Existing OpenAI Client

```ts
import OpenAI from "openai"

const rawOpenAI = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

const openai = orlune.wrap(existingOpenAIClient, {
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

If `customerId`, `eventType`, or effective `feature` is missing, the SDK skips telemetry for that invocation and logs a warning with `console.warn(...)`.

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
