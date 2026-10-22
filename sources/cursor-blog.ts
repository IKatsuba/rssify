import { load } from "cheerio"

import {
  escapeHtml,
  normaliseEntry,
  type IngestedEntry,
} from "@/lib/ingest/parse"
import { SafeFetchError } from "@/lib/ingest/safe-fetch"

import { SourceStatusError, type SourcePlugin } from "./types"

const LIST_URL = "https://cursor.com/blog"
const POSTS_PER_RUN = 10
const CONCURRENCY = 4
const TITLE_SUFFIX = " · Cursor"

export const LAYOUT_CHANGED = "the page layout changed"

type Ctx = Parameters<SourcePlugin["fetchEntries"]>[0]
type Post = { url: string; listDate: string | null }

const ok = (status: number) => status >= 200 && status < 300

const validDate = (value: string | undefined | null) =>
  value && !Number.isNaN(new Date(value).getTime()) ? value : null

// The post links of the list page, de-duplicated, in document order. Cards
// also link off-site (x.ai) and to the changelog; only our own posts count.
function listPosts(html: string, pageUrl: string): Post[] {
  const $ = load(html)
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

async function fetchPost(post: Post, ctx: Ctx): Promise<IngestedEntry | null> {
  let response
  try {
    response = await ctx.fetch(post.url, { deadline: ctx.deadline })
  } catch (error) {
    // One unreadable post is skipped; it is still unknown next run.
    if (error instanceof SafeFetchError) return null
    throw error
  }
  if (!ok(response.status)) return null

  const $ = load(response.text)
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
  async fetchEntries(ctx) {
    const response = await ctx.fetch(LIST_URL, { deadline: ctx.deadline })
    if (!ok(response.status)) {
      throw new SourceStatusError(response.status, response.headers)
    }
    const posts = listPosts(response.text, response.url)
    if (posts.length === 0) throw new Error(LAYOUT_CHANGED)

    const known = await ctx.known(posts.map((post) => post.url))
    const todo = posts
      .filter((post) => !known.has(post.url))
      .slice(0, POSTS_PER_RUN)

    // A small pool keeps at most four post fetches in flight.
    const results: (IngestedEntry | null)[] = new Array(todo.length).fill(null)
    let next = 0
    const worker = async () => {
      while (next < todo.length) {
        const index = next++
        results[index] = await fetchPost(todo[index], ctx)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker)
    )
    return results.filter((entry): entry is IngestedEntry => entry !== null)
  },
}
