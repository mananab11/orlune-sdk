import { observeProviderCall } from "./observe-provider-call.js"

type ApiEnvelope = { data: unknown; [key: string]: unknown }
type ApiPromiseLike = PromiseLike<unknown> & {
  asResponse?: () => Promise<unknown>
  withResponse?: () => Promise<ApiEnvelope>
}

/** Defer parsing, not invocation, so raw-response consumers retain body ownership. */
export function observeApiCall(params: {
  start: () => Promise<{ value: unknown }>
  onResult: (result: unknown) => Promise<unknown>
  onError: (error: unknown) => Promise<void>
}) {
  const call = observeProviderCall<ApiEnvelope>({
    start: params.start,
    readResult: async value => {
      const provider = value as ApiPromiseLike | null | undefined
      return typeof provider?.withResponse === "function"
        ? provider.withResponse() : { data: await value }
    },
    onResult: async result => ({ ...result, data: await params.onResult(result.data) }),
    onError: params.onError,
  })

  const asResponse = () => call.read(async value => {
    const provider = value as ApiPromiseLike | null | undefined
    if (typeof provider?.asResponse !== "function") {
      throw new TypeError("This provider call does not support asResponse().")
    }
    return provider.asResponse()
  })

  function view(envelope: () => Promise<ApiEnvelope>): ApiCallView {
    const data = () => envelope().then(result => result.data)
    return {
      then: (onfulfilled, onrejected) => data().then(onfulfilled, onrejected),
      catch: onrejected => data().catch(onrejected),
      finally: onfinally => data().finally(onfinally),
      [Symbol.toStringTag]: "Promise",
      withResponse: envelope,
      asResponse,
      // OpenAI's parse() helpers project the data through this hook. Reuse the
      // observed result rather than parsing the HTTP body or sending telemetry twice.
      _thenUnwrap(transform: (data: unknown) => unknown) {
        let projected: Promise<ApiEnvelope> | undefined
        return view(() => projected ??= envelope().then(result => ({ ...result, data: transform(result.data) })))
      },
    }
  }

  return view(call.result)
}

type ApiCallView = Promise<unknown> & {
  withResponse(): Promise<ApiEnvelope>
  asResponse(): Promise<unknown>
  _thenUnwrap(transform: (data: unknown) => unknown): ApiCallView
}
