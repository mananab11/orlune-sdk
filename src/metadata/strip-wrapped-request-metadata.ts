import type { OrluneCallMetadata } from "../types.js"

/** Remove SDK-only metadata without mutating the provider's request. */
export function stripWrappedRequestMetadata<TInput>(input: TInput): {
  cleanInput: TInput
  orluneMetadata: OrluneCallMetadata | undefined
} {
  if (typeof input !== "object" || input === null || Array.isArray(input) || !("orlune_metadata" in input)) {
    return { cleanInput: input, orluneMetadata: undefined }
  }

  const { orlune_metadata, ...rest } = input
  return {
    cleanInput: rest as TInput,
    orluneMetadata: orlune_metadata && typeof orlune_metadata === "object"
      ? orlune_metadata as OrluneCallMetadata : undefined,
  }
}
