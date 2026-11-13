export const TelemetryMode = Object.freeze({
  Sync: "sync",
  BackgroundFlush: "background_flush",
} as const)

export const GuardrailErrorMode = Object.freeze({
  Throw: "throw",
  Allow: "allow",
} as const)
