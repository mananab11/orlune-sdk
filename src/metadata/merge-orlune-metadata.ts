import type { OrluneCallMetadata, OrluneWrapDefaults } from "../types.js"

function isDefined<TValue>(value: TValue | undefined): value is TValue {
  return value !== undefined
}

/**
 * Merges wrapper-level defaults with per-call metadata.
 * Per-call values override wrapper defaults, while activity fields merge shallowly.
 */
export function mergeOrluneMetadata(
  wrapperDefaults?: OrluneWrapDefaults,
  callMetadata?: OrluneCallMetadata,
): OrluneCallMetadata | undefined {
  if (!wrapperDefaults && !callMetadata) {
    return undefined
  }

  const activityId = callMetadata?.activity?.id ?? wrapperDefaults?.activity?.id
  const activityType = callMetadata?.activity?.type ?? wrapperDefaults?.activity?.type
  const activityName = callMetadata?.activity?.name ?? wrapperDefaults?.activity?.name
  const customerId = callMetadata?.customerId
  const feature = callMetadata?.feature ?? wrapperDefaults?.feature
  const eventType = callMetadata?.eventType

  const merged: OrluneCallMetadata = {}

  if (isDefined(customerId)) {
    merged.customerId = customerId
  }

  if (isDefined(feature)) {
    merged.feature = feature
  }

  if (isDefined(eventType)) {
    merged.eventType = eventType
  }

  if (isDefined(activityId) || isDefined(activityType) || isDefined(activityName)) {
    merged.activity = {}

    if (isDefined(activityId)) {
      merged.activity.id = activityId
    }

    if (isDefined(activityType)) {
      merged.activity.type = activityType
    }

    if (isDefined(activityName)) {
      merged.activity.name = activityName
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined
}
