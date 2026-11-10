import OpenAI from "openai"
import { OrluneClient } from "../../dist/index.js"
import type { WithMetadataAtPath } from "../../dist/providers/wrapped-client-types.js"

const sdk = OrluneClient({ apiKey: "test", environment: "sandbox" })
const client = sdk.wrap(new OpenAI({ apiKey: "test" }))
const metadata = { customerId: "customer", eventType: "MODEL_CALL" }
const response = await client.responses.create({ model: "gpt-4.1", input: "Hi", orlune_metadata: metadata })
response.output_text satisfies string
const stream = await client.responses.create({ model: "gpt-4.1", input: "Hi", stream: true, orlune_metadata: metadata })
for await (const event of stream) { event.type satisfies string }
const chat = client.chat.completions.create({ model: "gpt-4.1", messages: [], orlune_metadata: metadata })
;(await chat).choices[0]?.message
const envelope = await chat.withResponse()
envelope.data.choices[0]?.message
envelope.response satisfies Response
await chat.asResponse() satisfies Response
const chatStream = await client.chat.completions.create({ model: "gpt-4.1", messages: [], stream: true, orlune_metadata: metadata })
for await (const chunk of chatStream) { chunk.choices[0]?.delta }
declare const streaming: boolean
const dynamic = await client.responses.create({ model: "gpt-4.1", stream: streaming, orlune_metadata: metadata })
if ("output_text" in dynamic) dynamic.output_text satisfies string
// @ts-expect-error wrong provider parameter must still be rejected
client.responses.create({ model: 42, orlune_metadata: metadata })
// @ts-expect-error wrong metadata type must still be rejected
client.responses.create({ model: "gpt-4.1", orlune_metadata: { customerId: 123 } })
// @ts-expect-error non-streaming response is not a stream
response[Symbol.asyncIterator]()
// @ts-expect-error unrelated methods are not instrumented
client.models.list({ orlune_metadata: metadata })

// A future adapter can reuse the types for a different provider method/path.
type AnotherProvider = { messages: { send(input: { text: string }, options?: { signal: AbortSignal }): Promise<{ reply: string }> } }
declare const futureClient: WithMetadataAtPath<AnotherProvider, "messages.send">
;(await futureClient.messages.send({ text: "Hi", orlune_metadata: metadata })).reply satisfies string

type ProviderTask = Promise<{ answer: string }> & { receipt(): Promise<string>; internalMethod(): void }
type CustomProvider = { generate(input: { text: string }): ProviderTask }
declare const customClient: WithMetadataAtPath<CustomProvider, "generate", "receipt">
const task = customClient.generate({ text: "Hello", orlune_metadata: metadata })
;(await task).answer satisfies string
await task.receipt() satisfies string
// @ts-expect-error the adapter does not expose an OpenAI helper
task.withResponse()
// @ts-expect-error unpreserved provider methods are not falsely advertised
task.internalMethod()
