import { load } from "cheerio"

import { safeUrl } from "./sanitize"

const FEED_TYPES = new Set([
  "application/rss+xml",
  "application/atom+xml",
  "application/rdf+xml",
  "application/feed+json",
  "application/json",
])

// The feeds a page announces with <link rel="alternate">, in document order.
// Only what the page declares: guessing paths like /feed would fetch
// addresses the site never offered.
export function discoverFeeds(html: string, pageUrl: string): string[] {
  const $ = load(html)
  // A relative <base href> is itself relative to the page.
  const base = safeUrl($("base[href]").first().attr("href"), pageUrl) ?? pageUrl
  const found = new Set<string>()
  $("link[rel][href]").each((_, link) => {
    const rel = ($(link).attr("rel") ?? "").toLowerCase().split(/\s+/)
    // A type may carry parameters, e.g. "application/rss+xml; charset=utf-8".
    const type = ($(link).attr("type") ?? "").split(";")[0].trim().toLowerCase()
    if (!rel.includes("alternate") || !FEED_TYPES.has(type)) return
    const url = safeUrl($(link).attr("href"), base)
    if (url) found.add(url)
  })
  return [...found]
}
