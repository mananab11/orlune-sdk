import { OrluneEvaluationException, OrluneGuardrailException, type GuardrailOptions } from "../guardrails.js"
import type { OrluneClient } from "../types.js"
import type { ensureActivityMetadata } from "../metadata/ensure-activity-metadata.js"
import { reportWarning } from "./report-warning.js"

export async function checkGuardrails(evaluate: OrluneClient["evaluate"], settings: GuardrailOptions,
  metadata: ReturnType<typeof ensureActivityMetadata>, signal?: AbortSignal, prompt?: string) {
  try {
    const result = await evaluate({
      customerId: metadata.customerId,
      activity: metadata.activity,
      ...(metadata.feature !== undefined ? { feature: metadata.feature } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
    }, {
      ...(signal ? { signal } : {}),
    })
    if (signal?.aborted) throw new OrluneEvaluationException("Evaluation canceled.", "ABORTED")
    if (result.decision === "BLOCK") throw new OrluneGuardrailException(result)
    if (result.decision === "NOT_EVALUATED") {
      reportWarning(result.reasonCode === "NO_ACTIVE_POLICIES"
        ? "[orlune] No active policies; proceeding without policy evaluation."
        : "[orlune] Evaluation limit exceeded; proceeding without policy evaluation. The organization allowance and buffer have been used for this period.")
    }
  } catch (error) {
    if (settings.onError !== "allow" || !(error instanceof OrluneEvaluationException) ||
        error.code === "INVALID_REQUEST" || error.code === "ABORTED") throw error
    reportWarning(`[orlune] Guardrail evaluation unavailable (${error.code}); proceeding because onError is "allow".`)
  }
}
