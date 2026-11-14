export const PRODUCTION_BASE_URL = "https://api.orlune.ai"

/** A single origin serves ingestion and evaluation; HTTP is only for loopback testing. */
export function resolveBaseURL(baseURL: string = PRODUCTION_BASE_URL): string {
  if (typeof baseURL !== "string" || !baseURL.trim()) throw new Error("baseURL must be a valid API origin.")
  let url: URL
  try { url = new URL(baseURL) } catch { throw new Error("baseURL must be a valid API origin.") }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("baseURL must be an HTTPS origin without credentials, path, query, or fragment (HTTP is allowed for localhost).")
  }
  return url.origin
}
