import type { OrluneCallMetadata, OrluneWrapDefaults } from "../types.js"

function isDefined<TValue>(value: TValue | undefined): value is TValue {
  return value !== undefined
}

/**
 * Merges wrapper-level defaults with per-call metadata.
 * Only feature has a wrapper default. Activity always comes from the call.
 */
export function mergeOrluneMetadata(
  wrapperDefaults?: OrluneWrapDefaults,
  callMetadata?: OrluneCallMetadata,
): Partial<OrluneCallMetadata> | undefined {
  if (!wrapperDefaults && !callMetadata) {
    return undefined
  }

  const activity = callMetadata?.activity
  const customerId = callMetadata?.customerId
  const feature = callMetadata?.feature ?? wrapperDefaults?.feature
  const eventType = callMetadata?.eventType

  const merged: Partial<OrluneCallMetadata> = {}

  if (isDefined(customerId)) {
    merged.customerId = customerId
  }

  if (isDefined(feature)) {
    merged.feature = feature
  }

  if (isDefined(eventType)) {
    merged.eventType = eventType
  }

  if (isDefined(activity)) {
    merged.activity = { ...activity }
  }

  return Object.keys(merged).length > 0 ? merged : undefined
}
