import { OrluneEvaluationException, type EvaluationRequest, type EvaluationOptions, type EvaluationResult } from "../guardrails.js"
import { reportWarning } from "./report-warning.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isResult(value: unknown): value is EvaluationResult {
  if (!isRecord(value) || typeof value.evaluationId !== "string" || !value.evaluationId ||
      typeof value.evaluatedAt !== "string" || !Number.isFinite(Date.parse(value.evaluatedAt)) ||
      typeof value.reasonCode !== "string" || !value.reasonCode) return false
  if (value.details !== undefined && (!isRecord(value.details) || !Object.values(value.details).every(
    (item) => item === null || typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))
  ))) return false
  if (value.decision === "ALLOW" && value.matchedRule === null) return true
  if (value.decision === "NOT_EVALUATED") {
    return (value.reasonCode === "EVALUATION_LIMIT_EXCEEDED" || value.reasonCode === "NO_ACTIVE_POLICIES") && value.matchedRule === null
  }
  return (value.decision === "ALLOW" || value.decision === "BLOCK") && isRecord(value.matchedRule) &&
      typeof value.matchedRule.id === "string" && Boolean(value.matchedRule.id) &&
      typeof value.matchedRule.name === "string" &&
      (value.matchedRule.message === null || typeof value.matchedRule.message === "string")
}

export function createEvaluator(apiKey: string, endpoint: string, defaultTimeoutMs = 5000) {
  return async (request: EvaluationRequest, options: EvaluationOptions = {}): Promise<EvaluationResult> => {
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
      throw new OrluneEvaluationException("Evaluation timeoutMs must be a positive duration.", "INVALID_REQUEST")
    }
    for (const [field, value] of Object.entries({ customerId: request?.customerId, feature: request?.feature, activityId: request?.activityId, activityType: request?.activityType })) {
      if (field === "feature" && value === undefined) continue
      const maxLength = field === "activityType" ? 128 : 256
      if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
        throw new OrluneEvaluationException(`${field} must be a non-empty string of at most ${maxLength} characters.`, "INVALID_REQUEST")
      }
    }
    if (request.prompt !== undefined && typeof request.prompt !== "string") {
      throw new OrluneEvaluationException("prompt must be a string.", "INVALID_REQUEST")
    }
    let prompt = request.prompt
    if (prompt !== undefined && prompt.length > 100_000) {
      reportWarning("[orlune] Prompt exceeds 100000 characters; analyzing only the beginning. Remaining text will not be checked.")
      let end = 100_000
      // Avoid splitting a UTF-16 surrogate pair at the transport limit.
      const last = prompt.charCodeAt(end - 1)
      const next = prompt.charCodeAt(end)
      if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--
      prompt = prompt.slice(0, end)
    }
    const controller = new AbortController()
    let timedOut = false
    const abort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) throw new OrluneEvaluationException("Evaluation canceled.", "ABORTED")
    options.signal?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ customerId: request.customerId, feature: request.feature, activityId: request.activityId, activityType: request.activityType, prompt }),
        signal: controller.signal,
      })
      if (!response.ok) {
        let message = `Guardrail evaluation failed (HTTP ${response.status}).`
        try {
          const body: unknown = await response.json()
          if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
            message += ` ${body.error.message.slice(0, 1000)}`
          }
        } catch {
          // Preserve the HTTP error when the server does not return structured JSON.
        }
        throw new OrluneEvaluationException(message, "HTTP_ERROR", response.status)
      }
      let result: unknown
      try { result = await response.json() } catch (cause) {
        throw new OrluneEvaluationException("Invalid guardrail evaluation response.", "INVALID_RESPONSE", undefined, { cause })
      }
      if (!isResult(result)) throw new OrluneEvaluationException("Invalid guardrail evaluation response.", "INVALID_RESPONSE")
      return result
    } catch (cause) {
      if (options.signal?.aborted) throw new OrluneEvaluationException("Evaluation canceled.", "ABORTED", undefined, { cause })
      if (timedOut) throw new OrluneEvaluationException("Guardrail evaluation timed out.", "TIMEOUT", undefined, { cause })
      if (cause instanceof OrluneEvaluationException) throw cause
      throw new OrluneEvaluationException("Unable to reach the guardrail evaluator.", "NETWORK_ERROR", undefined, { cause })
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
    }
  }
}
