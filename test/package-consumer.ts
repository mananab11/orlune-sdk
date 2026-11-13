import { OrluneClient, TelemetryMode, GuardrailErrorMode } from "orlune"
import type { OrluneCallMetadata } from "orlune"

const metadata: OrluneCallMetadata = {
  customerId: "customer", eventType: "TEST", activity: { id: "activity", type: "smoke" },
}
let sent = 0
globalThis.fetch = async (_input, init) => {
  const payload = JSON.parse(String(init?.body))
  if (payload.event.customerId !== metadata.customerId || payload.event.feature !== "UNKNOWN") {
    throw new Error("Invalid telemetry contract")
  }
  sent++
  return new Response(null, { status: 202 })
}
const sdk = OrluneClient({ apiKey: "local-test", baseURL: "https://test.invalid",
  telemetryDelivery: { mode: TelemetryMode.Sync } })
const native = { baseURL: "https://api.openai.com/v1", responses: {
  async create(input: { model: string }) {
    if ("orlune_metadata" in input) throw new Error("Metadata leaked to provider")
    return { id: "request", model: input.model, status: "completed", usage: { input_tokens: 1, output_tokens: 1 } }
  },
} }
const client = sdk.wrap(native, { guardrails: { enabled: false, onError: GuardrailErrorMode.Throw } })
const response = await client.responses.create({ model: "model", orlune_metadata: metadata })
if (response.id !== "request" || sent !== 1) throw new Error("Wrapped client smoke test failed")
