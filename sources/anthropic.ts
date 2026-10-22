import { load, type CheerioAPI } from "cheerio"

import {
  escapeHtml,
  normaliseEntry,
  type IngestedEntry,
} from "@/lib/ingest/parse"

import { fetchListThenPosts, type Post } from "./list-posts"
import type { SourcePlugin } from "./types"

const ORIGIN = "https://www.anthropic.com"
const TITLE_SUFFIX = " | Anthropic"
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

const validDate = (value: string | undefined | null) =>
  value && !Number.isNaN(new Date(value).getTime()) ? value : null

// List dates are text only ("Apr 8, 2026"): a calendar day, read as UTC
// midnight. Parsed by hand because Date's own parsing is lenient.
export function listDate(text: string): string | null {
  const match = text.trim().match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/)
  const month = match ? MONTHS.indexOf(match[1]) : -1
  if (!match || month < 0) return null
  const day = Number(match[2])
  const date = new Date(Date.UTC(Number(match[3]), month, day))
  return date.getUTCDate() === day ? date.toISOString() : null
}

// A same-origin post URL without query or hash, the guid; else null.
function postUrl(href: string | undefined, pageUrl: string) {
  if (!href) return null
  let url
  try {
    url = new URL(href, pageUrl)
  } catch {
    return null
  }
  if (url.origin !== ORIGIN) return null
  url.hash = ""
  url.search = ""
  return url.href
}

// Both sections serve the same post template. The body is found through
// the plain `post-text` class; its container's class is a CSS-module hash
// that changes between builds.
function readPost(html: string, post: Post): IngestedEntry {
  const $ = load(html)
  // Some pages' og:title carries the site name; most do not.
  const ogTitle = $('meta[property="og:title"]').attr("content")?.trim()
  const title = ogTitle?.endsWith(TITLE_SUFFIX)
    ? ogTitle.slice(0, -TITLE_SUFFIX.length)
    : ogTitle
  const description = $('meta[name="description"]').attr("content")
  const body = $("p.post-text").first().parent()
  const published =
    validDate($('meta[property="article:published_time"]').attr("content")) ??
    post.listDate

  // Meta values are plain text; normaliseEntry reads HTML, so escape them
  // and the entry comes out as a parsed feed's would.
  return normaliseEntry(
    {
      id: post.url,
      url: post.url,
      title: title ? escapeHtml(title) : null,
      published,
      summary: description ? escapeHtml(description) : null,
      content: body.length ? body.html() : null,
    },
    post.url
  )
}

function plugin(
  id: string,
  path: string,
  links: ($: CheerioAPI, pageUrl: string) => Post[]
): SourcePlugin {
  const listUrl = `${ORIGIN}${path}`
  const spellings = new Set(
    ["https://www.anthropic.com", "https://anthropic.com"].flatMap((o) => [
      `${o}${path}`,
      `${o}${path}/`,
    ])
  )
  return {
    id,
    // href is already normalised, so a query, hash, port or credentials
    // make it no spelling of ours.
    canonical: (url) => (spellings.has(url.href) ? listUrl : null),
    fetchEntries: (ctx) =>
      fetchListThenPosts(ctx, { listUrl, links, readPost }),
  }
}

// Posts are listed under /engineering but live under /research, so the
// link is taken from each card whatever its path.
export const anthropicEngineering = plugin(
  "anthropic-engineering",
  "/engineering",
  ($, pageUrl) => {
    const posts = new Map<string, Post>()
    $("article").each((_, article) => {
      const url = postUrl(
        $(article).find("h3 a[href]").first().attr("href"),
        pageUrl
      )
      if (!url || posts.has(url)) return
      posts.set(url, {
        url,
        listDate: listDate($(article).find("time").first().text()),
      })
    })
    return [...posts.values()]
  }
)

// The news page is a featured grid and a table, with topic links mixed in.
// The most fragile selector of the sources: it leans on the component half
// of CSS-module class names (`FeaturedGrid-…__tileLink`,
// `TableView-…__title-link`), not the hash. No path rule: launch pages
// live at the root and features under /features.
export const anthropicNews = plugin("anthropic-news", "/news", ($, pageUrl) => {
  const selector = 'a[href][class*="title-link"], a[href][class*="tileLink"]'
  const posts = new Map<string, Post>()
  $(selector).each((_, link) => {
    const url = postUrl($(link).attr("href"), pageUrl)
    if (!url || posts.has(url)) return
    // A tile's or row's date is in its nearest container with a time,
    // unless that container also holds another post: then the time is
    // that post's, and this one is undated.
    const container = $(link).closest(":has(time)")
    const shared = container
      .find(selector)
      .toArray()
      .some((other) => postUrl($(other).attr("href"), pageUrl) !== url)
    const time = shared ? "" : container.find("time").first().text()
    posts.set(url, { url, listDate: listDate(time) })
  })
  return [...posts.values()]
})
