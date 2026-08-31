import type { OrluneCallMetadata } from "../types.js"

function randomActivityId(): string {
  return crypto.randomUUID()
}

/**
 * Ensures every tracked invocation has an activity identity.
 * If the caller did not supply one, the SDK creates a standalone activity id.
 * Activity type falls back to feature when available.
 */
export function ensureActivityMetadata(
  metadata?: OrluneCallMetadata,
): OrluneCallMetadata | undefined {
  if (!metadata) {
    return {
      activity: {
        id: randomActivityId(),
      },
    }
  }

  const activityId = metadata.activity?.id ?? randomActivityId()
  const activityType = metadata.activity?.type ?? metadata.feature
  const activityName = metadata.activity?.name

  return {
    ...metadata,
    activity: {
      id: activityId,
      ...(activityType ? { type: activityType } : {}),
      ...(activityName ? { name: activityName } : {}),
    },
  }
}
