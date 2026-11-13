import type { OrluneActivityMetadata, OrluneCallMetadata } from "../types.js"

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty string of at most ${maxLength} characters in per-call metadata.`)
  }
  return value
}

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

  const customerId = requiredString(metadata?.customerId, "customerId", 256)
  const eventType = requiredString(metadata?.eventType, "eventType", 128)
  if (metadata?.feature !== undefined &&
      (typeof metadata.feature !== "string" || !metadata.feature.trim() || metadata.feature.length > 256)) {
    throw new Error("feature must be a non-empty string of at most 256 characters when provided.")
  }

  return {
    ...metadata,
    customerId,
    eventType,
    activity: {
      id: activityId,
      type: activityType,
    },
  }
}
