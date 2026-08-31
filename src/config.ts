import type { ClientEnvironment } from "./types.js"

export const ORLUNE_PRODUCTION_EVENTS_URL =
  "https://du37zudv2g.execute-api.us-west-2.amazonaws.com/v1/events"

/**
 * Sandbox is intentionally blocked until a dedicated endpoint exists.
 */
export function resolveEventsEndpoint(environment: ClientEnvironment): string {
  if (environment === "production") {
    return ORLUNE_PRODUCTION_EVENTS_URL
  }

  throw new Error("Sandbox environment is not configured yet.")
}
