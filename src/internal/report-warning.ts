/** Diagnostics must never change whether a provider request proceeds. */
export function reportWarning(message: string): void {
  try {
    console.warn(message)
  } catch {
    // Application logging is best-effort.
  }
}
