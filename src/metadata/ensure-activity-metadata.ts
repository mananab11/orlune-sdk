import type { OrluneActivityMetadata, OrluneCallMetadata } from "../types.js"

/**
 * Validates the explicit activity identity supplied with each invocation.
 */
export function ensureActivityMetadata(
  metadata?: Partial<OrluneCallMetadata>,
): OrluneCallMetadata & { activity: OrluneActivityMetadata } {
  const activityType = metadata?.activity?.type
  if (typeof activityType !== "string" || !activityType.trim() || activityType.length > 128) {
    throw new Error("activity.type must be a non-empty string of at most 128 characters in per-call metadata.")
  }
  const activityId = metadata?.activity?.id
  if (typeof activityId !== "string" || !activityId.trim() || activityId.length > 256) {
    throw new Error("activity.id must be a non-empty string of at most 256 characters in per-call metadata.")
  }

  return {
    ...metadata,
    activity: {
      id: activityId,
      type: activityType,
    },
  }
}
