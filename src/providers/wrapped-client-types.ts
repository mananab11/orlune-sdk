import type { WrappedClientRequestMetadata } from "../types.js"

/** Public promise surface preserved by the provider-call adapter. */
type ObservedReturn<R, Helpers extends PropertyKey> = R extends PromiseLike<unknown>
  ? Promise<Awaited<R>> & Pick<R, Extract<keyof R, Helpers>>
  : R

type MetadataArguments<A extends unknown[]> = A extends [infer Input, ...infer Rest]
  ? [Input & WrappedClientRequestMetadata, ...Rest]
  : A

// Preserve up to three call signatures rather than collapsing to the last.
// Each adapter declares which extra promise helpers it preserves.
export type MetadataMethod<F, Helpers extends PropertyKey = never> = F extends {
  (...args: infer A1): infer R1
  (...args: infer A2): infer R2
  (...args: infer A3): infer R3
} ? {
  (...args: MetadataArguments<A1>): ObservedReturn<R1, Helpers>
  (...args: MetadataArguments<A2>): ObservedReturn<R2, Helpers>
  (...args: MetadataArguments<A3>): ObservedReturn<R3, Helpers>
} : F

/** Extend only paths that an adapter intercepts; leave other methods untouched. */
export type WithMetadataAtPath<T, Path extends string, Helpers extends PropertyKey = never> = {
  [K in keyof T]: K extends string
    ? K extends Path ? MetadataMethod<T[K], Helpers>
      : Extract<Path, `${K}.${string}`> extends never ? T[K]
      : WithMetadataAtPath<T[K], Extract<Path, `${K}.${string}`> extends `${K}.${infer Rest}` ? Rest : never, Helpers>
    : T[K]
}

