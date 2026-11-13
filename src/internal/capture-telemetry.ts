export function reportTelemetryError(message = "[orlune] Telemetry capture failed."): void {
  try {
    console.error(message)
  } catch {
    // Application logging must not affect provider calls either.
  }
}

/** Telemetry construction must not replace a provider result or exception. */
export async function captureTelemetry(capture: () => Promise<void>): Promise<void> {
  try {
    await capture()
  } catch {
    reportTelemetryError()
  }
}
