import { pluginFor, plugins as registeredPlugins } from "@/sources/index"
import type { SourcePlugin } from "@/sources/types"

// A WHATWG parse, http(s) only, no fragment.
export function normaliseUrl(input: string) {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  url.hash = ""
  return url.href
}

// The URL a subscription is stored under; null is invalid_url. Pure, so it
// can run before the known-feed lookup, and idempotent, so every spelling
// of one plugin address reaches one Feed row. A plain feed URL is only
// normalised.
export function canonicalUrl(
  input: string,
  plugins: Record<string, SourcePlugin> = registeredPlugins
): string | null {
  const url = normaliseUrl(input)
  if (!url) return null
  return pluginFor(url, plugins)?.url ?? url
}
