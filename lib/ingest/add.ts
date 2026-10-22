import { builtinSources } from "@/sources/builtin"
import { pluginFor, plugins as registeredPlugins } from "@/sources/index"
import { SourceStatusError, type SourcePlugin } from "@/sources/types"

import { discoverFeeds } from "./discover"
import { FeedParseError, parseFeed, type IngestedEntry } from "./parse"
import { safeFetch, SafeFetchError, type SafeFetch } from "./safe-fetch"

const FETCH_TIMEOUT = 15_000
const PLUGIN_TIMEOUT = 40_000

export type AddErrorCode =
  "invalid_url" | "blocked" | "unreachable" | "too_large" | "not_found"

export type NewFeed = {
  pluginId: string | null
  title: string | null
  siteUrl: string | null
  entries: IngestedEntry[]
  etag: string | null
  lastModified: string | null
}

export type AddOptions = {
  fetch?: SafeFetch
  plugins?: Record<string, SourcePlugin>
}

// What one address gave on a first fetch: a feed, an HTML page and the
// feeds it announces (the caller picks), or a failure code.
export type FetchedForAdd =
  | { kind: "feed"; feed: NewFeed }
  | { kind: "page"; feeds: string[] }
  | { kind: "error"; code: AddErrorCode }

const failed = (code: AddErrorCode) => ({ kind: "error", code }) as const

// A non-2xx answer, from a feed or from a plugin's list page.
const answered = (status: number) =>
  failed(status === 404 || status === 410 ? "not_found" : "unreachable")

// Discovery only reads an HTML page. The body is sniffed, as Content-Type
// is often missing or wrong, and an HTML Content-Type counts as well. The
// sniff skips what may precede the root: a BOM, whitespace, an XML prolog
// (XHTML) and comments. A page may leave out <html> and start with a head
// element; a false positive costs nothing, as finding no feed links is
// not_found anyway. A loop, not one regex, so a body of many comments
// cannot make it backtrack.
function isHtml(text: string, headers: Headers) {
  const type = headers.get("content-type")?.split(";")[0].trim().toLowerCase()
  if (type === "text/html" || type === "application/xhtml+xml") return true
  const skip = (from: number) => {
    while (/\s/.test(text[from] ?? "")) from++
    return from
  }
  let at = skip(text.startsWith("\uFEFF") ? 1 : 0)
  if (text.startsWith("<?xml", at)) {
    const end = text.indexOf("?>", at)
    if (end < 0) return false
    at = skip(end + 2)
  }
  while (text.startsWith("<!--", at)) {
    const end = text.indexOf("-->", at + 4)
    if (end < 0) return false
    at = skip(end + 3)
  }
  return /^<(?:!doctype\s+html|html|head|meta|link)[\s/>]/i.test(
    text.slice(at, at + 16)
  )
}

export async function fetchForAdd(
  url: string,
  { fetch = safeFetch, plugins = registeredPlugins }: AddOptions = {}
): Promise<FetchedForAdd> {
  const owned = pluginFor(url, plugins)
  if (owned) return runPlugin(owned.plugin, owned.url, fetch)

  let response
  try {
    response = await fetch(url, {
      deadline: AbortSignal.timeout(FETCH_TIMEOUT),
    })
  } catch (error) {
    if (!(error instanceof SafeFetchError)) throw error
    return failed(error.code)
  }
  if (response.status < 200 || response.status >= 300) {
    return answered(response.status)
  }

  try {
    // Relative links belong to the document as served, after redirects.
    const parsed = parseFeed(response.text, response.url)
    return {
      kind: "feed",
      feed: {
        pluginId: null,
        title: parsed.title,
        siteUrl: parsed.siteUrl,
        entries: parsed.entries,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      },
    }
  } catch (error) {
    if (!(error instanceof FeedParseError)) throw error
  }
  if (!isHtml(response.text, response.headers)) return failed("not_found")
  return { kind: "page", feeds: discoverFeeds(response.text, response.url) }
}

async function runPlugin(
  plugin: SourcePlugin,
  url: string,
  fetch: SafeFetch
): Promise<FetchedForAdd> {
  let entries
  try {
    entries = await plugin.fetchEntries({
      url,
      fetch,
      // Nothing of a new feed is stored yet.
      known: async () => new Set(),
      deadline: AbortSignal.timeout(PLUGIN_TIMEOUT),
    })
  } catch (error) {
    // Whatever a plugin throws is the source failing, not us: a fetch
    // error keeps its code, a list page's status reads as a feed's would,
    // anything else (a page it can't read) and an empty result below are
    // not_found.
    if (error instanceof SafeFetchError) return failed(error.code)
    if (error instanceof SourceStatusError) return answered(error.status)
    return failed("not_found")
  }
  if (entries.length === 0) return failed("not_found")
  return {
    kind: "feed",
    feed: {
      pluginId: plugin.id,
      // A plugin page has no feed title; a built-in source names it, else
      // the plugin may build one from its URL.
      title:
        builtinSources.find((source) => source.url === url)?.title ??
        plugin.title?.(url) ??
        null,
      siteUrl: url,
      entries,
      etag: null,
      lastModified: null,
    },
  }
}
