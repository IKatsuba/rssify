import { load, type CheerioAPI } from "cheerio"

import {
  escapeHtml,
  normaliseEntry,
  type IngestedEntry,
} from "@/lib/ingest/parse"

import { fetchListThenPosts, type Post } from "./list-posts"
import type { SourcePlugin } from "./types"

const LIST_URL = "https://cursor.com/blog"
const TITLE_SUFFIX = " · Cursor"

export { LAYOUT_CHANGED } from "./list-posts"

const validDate = (value: string | undefined | null) =>
  value && !Number.isNaN(new Date(value).getTime()) ? value : null

// The post links of the list page, de-duplicated, in document order. Cards
// also link off-site (x.ai) and to the changelog; only our own posts count.
function links($: CheerioAPI, pageUrl: string): Post[] {
  const origin = new URL(LIST_URL).origin
  const posts = new Map<string, Post>()
  $("article").each((_, article) => {
    const closest = $(article).closest("a")
    const link = closest.length ? closest : $(article).find("a").first()
    const href = link.attr("href")
    if (!href) return
    let url
    try {
      url = new URL(href, pageUrl)
    } catch {
      return
    }
    if (url.origin !== origin || !url.pathname.startsWith("/blog/")) return
    if (url.pathname === "/blog/") return
    url.hash = ""
    url.search = ""
    if (posts.has(url.href)) return
    posts.set(url.href, {
      url: url.href,
      listDate: validDate($(article).find("time[datetime]").attr("datetime")),
    })
  })
  return [...posts.values()]
}

function readPost(html: string, post: Post): IngestedEntry {
  const $ = load(html)
  const ogTitle = $('meta[property="og:title"]').attr("content")?.trim()
  const title = ogTitle?.endsWith(TITLE_SUFFIX)
    ? ogTitle.slice(0, -TITLE_SUFFIX.length)
    : ogTitle
  const description = $('meta[name="description"]').attr("content")
  const prose = $(".prose--blog").first()
  const published =
    validDate($('meta[property="article:published_time"]').attr("content")) ??
    validDate($("time[datetime]").first().attr("datetime")) ??
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
      content: prose.length ? prose.html() : null,
    },
    post.url
  )
}

export const cursorBlog: SourcePlugin = {
  id: "cursor-blog",
  // Exact, as before: the list page and nothing else.
  canonical: (url) => (url.href === LIST_URL ? LIST_URL : null),
  fetchEntries: (ctx) =>
    fetchListThenPosts(ctx, { listUrl: LIST_URL, links, readPost }),
}
