import Anthropic from "@anthropic-ai/sdk"
import { OrluneClient } from "../../dist/index.js"

const client = OrluneClient({ apiKey: "test", environment: "sandbox" }).wrap(new Anthropic({ apiKey: "test" }))
const params = { model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user" as const, content: "Hi" }],
  orlune_metadata: { customerId: "customer", eventType: "REPLY", activity: { id: "conversation", type: "support" } } }
const pending = client.messages.create(params)
;(await pending).usage.input_tokens satisfies number
;(await pending.withResponse()).data.content satisfies Anthropic.ContentBlock[]
await pending.asResponse() satisfies Response
const stream = await client.messages.create({ ...params, stream: true })
for await (const event of stream) event.type satisfies string
const helper = client.messages.stream(params)
helper.on("text", text => text satisfies string)
;(await helper.finalMessage()).usage.output_tokens satisfies number
;(await helper.withResponse()).response satisfies Response
await helper.finalText() satisfies string
helper.abort()
// @ts-expect-error a supplied activity must include its own type
client.messages.create({ ...params, orlune_metadata: { activity: { id: "conversation" } } })
// @ts-expect-error activity is not a wrapper default
OrluneClient({ apiKey: "test", environment: "sandbox" }).wrap(new Anthropic({ apiKey: "test" }), { defaults: { activity: { id: "conversation", type: "support" } } })
// @ts-expect-error activity ID is required
client.messages.create({ ...params, orlune_metadata: { activity: { type: "support" } } })
// @ts-expect-error max_tokens is required
client.messages.create({ model: "claude-haiku-4-5", messages: [] })
// @ts-expect-error invalid metadata must still fail type checking
client.messages.create({ ...params, orlune_metadata: { customerId: 12 } })
// @ts-expect-error normal Message is not an event stream
;(await pending)[Symbol.asyncIterator]()
