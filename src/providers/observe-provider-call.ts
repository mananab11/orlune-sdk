import { captureTelemetry, reportTelemetryError } from "../internal/capture-telemetry.js"

/** Share one invocation and observation without assuming a provider's promise API. */
export function observeProviderCall<Result>(params: {
  start: () => Promise<{ value: unknown }>
  readResult: (value: unknown) => Promise<Result>
  onResult: (result: Result) => Promise<Result>
  onError: (error: unknown) => Promise<void>
}) {
  const started = params.start()
  // Requests start immediately, even if the caller attaches a consumer later.
  void started.catch(() => {})
  let result: Promise<Result> | undefined
  let errorReporting: Promise<void> | undefined

  async function reportError(error: unknown): Promise<never> {
    errorReporting ??= captureTelemetry(() => params.onError(error))
    await errorReporting
    throw error
  }

  function read<T>(reader: (value: unknown) => Promise<T>): Promise<T> {
    return started.then(async ({ value }) => {
      try {
        return await reader(value)
      } catch (error) {
        return reportError(error)
      }
    })
  }

  return {
    result(): Promise<Result> {
      result ??= read(async value => {
        const providerResult = await params.readResult(value)
        try {
          return await params.onResult(providerResult)
        } catch {
          reportTelemetryError()
          return providerResult
        }
      })
      return result
    },
    read,
  }
}
