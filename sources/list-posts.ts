import { load, type CheerioAPI } from "cheerio"

import type { IngestedEntry } from "@/lib/ingest/parse"
import { SafeFetchError } from "@/lib/ingest/safe-fetch"

import { SourceStatusError, type SourcePlugin } from "./types"

// Lists are newest first: the first 30 bound a new feed's backfill to its
// newest posts, so a long archive is never walked (or refetched past
// retention).
const CANDIDATES = 30
const POSTS_PER_RUN = 10
const CONCURRENCY = 4

export const LAYOUT_CHANGED = "the page layout changed"
export const NONE_READ = "none of the new posts could be read"

type Ctx = Parameters<SourcePlugin["fetchEntries"]>[0]
// The guid is the post URL, so links() strips its query and hash.
export type Post = { url: string; listDate: string | null }

const ok = (status: number) => status >= 200 && status < 300

// The shared algorithm of sites that list posts on one page and keep each
// post's content on its own page.
export async function fetchListThenPosts(
  ctx: Ctx,
  {
    listUrl,
    links,
    readPost,
  }: {
    listUrl: string
    // Document order, de-duplicated.
    links($: CheerioAPI, pageUrl: string): Post[]
    // null: not a post page.
    readPost(html: string, post: Post): IngestedEntry | null
  }
): Promise<IngestedEntry[]> {
  const response = await ctx.fetch(listUrl, { deadline: ctx.deadline })
  if (!ok(response.status)) {
    throw new SourceStatusError(response.status, response.headers)
  }
  const posts = links(load(response.text), response.url).slice(0, CANDIDATES)
  if (posts.length === 0) throw new Error(LAYOUT_CHANGED)

  const known = await ctx.known(posts.map((post) => post.url))
  const todo = posts
    .filter((post) => !known.has(post.url))
    .slice(0, POSTS_PER_RUN)
  if (todo.length === 0) return []

  let abortError: SafeFetchError | undefined
  const read = async (post: Post) => {
    let page
    try {
      page = await ctx.fetch(post.url, { deadline: ctx.deadline })
    } catch (error) {
      // One unreadable post is skipped; it is still unknown next run.
      if (!(error instanceof SafeFetchError)) throw error
      if (ctx.deadline.aborted) abortError ??= error
      return null
    }
    return ok(page.status) ? readPost(page.text, post) : null
  }

  // A small pool keeps at most four post fetches in flight, and starts no
  // new one once the deadline has passed.
  const results: (IngestedEntry | null)[] = new Array(todo.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < todo.length && !ctx.deadline.aborted) {
      const index = next++
      results[index] = await read(todo[index])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker)
  )

  const entries = results.filter((entry) => entry !== null)
  // Nothing read is a failure, not an empty success that would reset the
  // feed's backoff; a timeout keeps its own text.
  if (entries.length === 0) throw abortError ?? new Error(NONE_READ)
  return entries
}
