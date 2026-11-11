import { OrluneEvaluationException, OrluneGuardrailException } from "../../guardrails.js"

function originalError(error: unknown): unknown {
  // Anthropic's MessageStream wraps non-Anthropic errors and retains their cause.
  const cause = error instanceof Error ? error.cause : undefined
  return cause instanceof OrluneGuardrailException || cause instanceof OrluneEvaluationException ? cause : error
}

function preserveReadableErrors(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = stream.getReader()
  // Forward native bytes and cancellation without rebuilding Anthropic's serialization.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) {
          reader.releaseLock()
          controller.close()
        } else controller.enqueue(value)
      } catch (error) {
        reader.releaseLock()
        controller.error(originalError(error))
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) }
      catch (error) { throw originalError(error) }
      finally { reader.releaseLock() }
    },
  }, { highWaterMark: 0 })
}

/** Keep native stream behavior, but expose Orlune exceptions at the public boundary. */
export function preserveGuardrailErrors<T extends object>(stream: T): T {
  const listeners = new WeakMap<Function, (...args: unknown[]) => unknown>()
  const proxy = new Proxy(stream, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target)
      if (typeof value !== "function") return value
      if (key === "on" || key === "once" || key === "off") {
        return (event: unknown, listener: (...args: unknown[]) => unknown) => {
          let forwarded = listener
          if (event === "error") {
            forwarded = listeners.get(listener) ?? function (this: unknown, error: unknown) {
              return listener.call(this, originalError(error))
            }
            listeners.set(listener, forwarded)
          }
          const result = Reflect.apply(value, target, [event, forwarded])
          return result === target ? proxy : result
        }
      }
      if (key === Symbol.asyncIterator) return () => {
        const iterator = Reflect.apply(value, target, []) as AsyncIterator<unknown>
        const invoke = async (method: "next" | "return" | "throw", arg?: unknown) => {
          try {
            const fn = iterator[method]
            if (fn) return await fn.call(iterator, arg)
            if (method === "throw") throw arg
            return { done: true as const, value: arg }
          } catch (error) { throw originalError(error) }
        }
        return { next: () => invoke("next"), return: (v?: unknown) => invoke("return", v),
          throw: (e?: unknown) => invoke("throw", e), [Symbol.asyncIterator]() { return this } }
      }
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args)
        if (result === target) return proxy
        if (key === "toReadableStream") return preserveReadableErrors(result as ReadableStream<Uint8Array>)
        if (result instanceof Promise) return result.then(value => {
          if (key === "emitted" && args[0] === "error") return originalError(value)
          if (key === "withResponse" && value?.data === target) return { ...value, data: proxy }
          return value
        }, error => { throw originalError(error) })
        return result
      }
    },
  })
  return proxy
}
