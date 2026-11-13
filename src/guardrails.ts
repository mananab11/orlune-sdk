import type { GuardrailErrorMode } from "./options.js"

export type EvaluationRequest = { customerId: string; feature?: string; activityId: string; activityType: string; prompt?: string }
export type EvaluationOptions = { timeoutMs?: number; signal?: AbortSignal }
export type GuardrailOptions = { enabled: boolean; onError?: typeof GuardrailErrorMode[keyof typeof GuardrailErrorMode]; timeoutMs?: number }
type EvaluationBase = {
  evaluationId: string
  evaluatedAt: string
  reasonCode: string
  details?: Record<string, string | number | boolean | null>
  promptAnalysis?:
    | { status: "unavailable" }
    | { status: "completed"; promptInjection?: { detected: boolean; explanation?: string }; allowedIntent?: { detected: boolean; explanation?: string } }
}
export type EvaluationResult = EvaluationBase & (
  | { decision: "ALLOW"; matchedRule: { id: string; name: string; message: string | null } | null }
  | { decision: "BLOCK"; matchedRule: { id: string; name: string; message: string | null } }
  | { decision: "NOT_EVALUATED"; reasonCode: "EVALUATION_LIMIT_EXCEEDED" | "NO_ACTIVE_POLICIES"; matchedRule: null }
)

export class OrluneGuardrailException extends Error {
  readonly evaluationId: string
  readonly evaluatedAt: string
  readonly reasonCode: string
  readonly matchedRule: Extract<EvaluationResult, { decision: "BLOCK" }>["matchedRule"]
  readonly details: EvaluationResult["details"]
  readonly decision = "BLOCK"

  constructor(readonly result: Extract<EvaluationResult, { decision: "BLOCK" }>) {
    super(result.matchedRule.message || "This request was blocked by an Orlune guardrail.")
    this.name = "OrluneGuardrailException"
    this.evaluationId = result.evaluationId
    this.evaluatedAt = result.evaluatedAt
    this.reasonCode = result.reasonCode
    this.matchedRule = result.matchedRule
    this.details = result.details
  }
}

export type EvaluationErrorCode = "INVALID_REQUEST" | "TIMEOUT" | "ABORTED" | "HTTP_ERROR" | "NETWORK_ERROR" | "INVALID_RESPONSE"
export class OrluneEvaluationException extends Error {
  constructor(message: string, readonly code: EvaluationErrorCode, readonly status?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = "OrluneEvaluationException"
  }
}
