import { load, type CheerioAPI } from "cheerio"

import {
  escapeHtml,
  normaliseEntry,
  type IngestedEntry,
} from "@/lib/ingest/parse"

import { fetchListThenPosts, type Post } from "./list-posts"
import type { SourcePlugin } from "./types"

const ORIGIN = "https://bytes.dev"
const LIST_URL = `${ORIGIN}/archives`
const SPELLINGS = new Set(
  [ORIGIN, "https://www.bytes.dev"].flatMap((o) => [
    `${o}/archives`,
    `${o}/archives/`,
  ])
)

// Card dates are US month/day/year, and the site does not pad them
// ("10/9/2026"): a calendar day, read as UTC midnight. Parsed by hand
// because Date's own parsing is lenient.
export function cardDate(text: string): string | null {
  const match = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!match) return null
  const [month, day] = [Number(match[1]) - 1, Number(match[2])]
  const date = new Date(Date.UTC(Number(match[3]), month, day))
  return date.getUTCMonth() === month && date.getUTCDate() === day
    ? date.toISOString()
    : null
}

// Issue links in document order, de-duplicated; the card's first span is
// its date.
function links($: CheerioAPI, pageUrl: string): Post[] {
  const posts = new Map<string, Post>()
  $('a[href^="/archives/"]').each((_, link) => {
    let url
    try {
      url = new URL($(link).attr("href")!, pageUrl)
    } catch {
      return
    }
    if (url.origin !== ORIGIN || !/^\/archives\/\d+$/.test(url.pathname)) {
      return
    }
    url.hash = ""
    url.search = ""
    if (posts.has(url.href)) return
    posts.set(url.href, {
      url: url.href,
      listDate: cardDate($(link).find("span").first().text()),
    })
  })
  return [...posts.values()]
}

// Issues carry no class or id on their body; every template so far opens
// it with a "Today’s issue" paragraph.
function readPost(html: string, post: Post): IngestedEntry {
  const $ = load(html)
  const title = $('meta[property="og:title"]').attr("content")?.trim()
  const description = $('meta[name="description"]').attr("content")
  const body = $("p")
    .filter((_, p) => $(p).text().trim().startsWith("Today’s issue"))
    .first()
    .parent()

  // Meta values are plain text; normaliseEntry reads HTML, so escape them
  // and the entry comes out as a parsed feed's would.
  return normaliseEntry(
    {
      id: post.url,
      url: post.url,
      title: title ? escapeHtml(title) : null,
      published: post.listDate,
      summary: description ? escapeHtml(description) : null,
      content: body.length ? body.html() : null,
    },
    post.url
  )
}

export const bytes: SourcePlugin = {
  id: "bytes",
  // href is already normalised, so a query, hash, port or credentials
  // make it no spelling of ours.
  canonical: (url) => (SPELLINGS.has(url.href) ? LIST_URL : null),
  fetchEntries: (ctx) =>
    fetchListThenPosts(ctx, { listUrl: LIST_URL, links, readPost }),
}
