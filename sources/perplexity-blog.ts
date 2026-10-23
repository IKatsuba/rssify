import { load, type CheerioAPI } from "cheerio"

import {
  escapeHtml,
  normaliseEntry,
  type IngestedEntry,
} from "@/lib/ingest/parse"

import {
  fetchListThenPosts,
  LAYOUT_CHANGED,
  NONE_READ,
  type Post,
} from "./list-posts"
import type { SourcePlugin } from "./types"

const ORIGIN = "https://www.perplexity.ai"
const BLOG = "/hub/blog/"
// Two categories, not the whole blog: most of /hub/blog is Ideas.
const LIST_URLS = new Set(
  ["research", "developers"].map((c) => `${ORIGIN}${BLOG}category/${c}`)
)

export { LAYOUT_CHANGED } from "./list-posts"

const validDate = (value: string | undefined | null) =>
  value && !Number.isNaN(new Date(value).getTime()) ? value : null

// The post links of a category page, de-duplicated, in document order. A
// post is linked from the featured card and again from the list; not every
// card has a time, so a later link may date an earlier one.
function links($: CheerioAPI, pageUrl: string): Post[] {
  const posts = new Map<string, Post>()
  $("a[href]").each((_, link) => {
    let url
    try {
      url = new URL($(link).attr("href")!, pageUrl)
    } catch {
      return
    }
    if (url.origin !== ORIGIN || !url.pathname.startsWith(BLOG)) return
    const slug = url.pathname.slice(BLOG.length)
    if (!slug || slug.includes("/")) return
    url.hash = ""
    url.search = ""
    const listDate = validDate($(link).find("time[datetime]").attr("datetime"))
    const post = posts.get(url.href)
    if (post) post.listDate ??= listDate
    else posts.set(url.href, { url: url.href, listDate })
  })
  return [...posts.values()]
}

// The body column has Tailwind classes only; the header shares its width
// but is a <header>, and the share box is a later column. A page without
// it is skipped, not thrown: a throw would fail the run and leave the post
// unknown, so one odd post would block every newer one.
function readPost(html: string, post: Post): IngestedEntry | null {
  const $ = load(html)
  const body = $('article div[class~="max-w-[760px]"]').first()
  if (!body.length) return null
  const title =
    $("article h1").first().text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim()
  const description = $('meta[name="description"]').attr("content")
  const published =
    validDate($("article time[datetime]").first().attr("datetime")) ??
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
      content: body.html(),
    },
    post.url
  )
}

export const perplexityBlog: SourcePlugin = {
  id: "perplexity-blog",
  // Exact: the URL is the category, the plugin's whole configuration.
  canonical: (url) => (LIST_URLS.has(url.href) ? url.href : null),
  fetchEntries: async (ctx) => {
    let missing = 0
    try {
      return await fetchListThenPosts(ctx, {
        listUrl: ctx.url,
        links,
        readPost: (html, post) => {
          const entry = readPost(html, post)
          if (!entry) missing++
          return entry
        },
      })
    } catch (error) {
      // Nothing read and the column missing: the layout moved, not the site.
      if (
        missing > 0 &&
        error instanceof Error &&
        error.message === NONE_READ
      ) {
        throw new Error(LAYOUT_CHANGED)
      }
      throw error
    }
  },
}
