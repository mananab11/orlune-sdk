import type { ClientEnvironment } from "./types.js"

export const ORLUNE_PRODUCTION_EVENTS_URL =
  "https://dx02lonqo8.execute-api.us-east-1.amazonaws.com/v1/events"

export const ORLUNE_DEVELOPMENT_EVENTS_URL =
  "https://tcum999ahg.execute-api.us-east-1.amazonaws.com/v1/events"

const ORLUNE_SANDBOX_EVENTS_URL =
  "https://du37zudv2g.execute-api.us-west-2.amazonaws.com/v1/events"

export function resolveEventsEndpoint(environment: ClientEnvironment): string {
  if (environment === "production") {
    return ORLUNE_PRODUCTION_EVENTS_URL
  }

  if (environment === "development") {
    return ORLUNE_DEVELOPMENT_EVENTS_URL
  }

  if (environment === "sandbox") {
    return ORLUNE_SANDBOX_EVENTS_URL
  }

  throw new Error('environment must be "production", "development", or "sandbox".')
}
