import { describe, expect, test } from "bun:test"

import type { IngestedEntry } from "@/lib/ingest/parse"
import type { SafeFetch } from "@/lib/ingest/safe-fetch"

import { fetchListThenPosts, NONE_READ, type Post } from "./list-posts"
import { SourceStatusError } from "./types"

const LIST = "https://example.test/archive"
const entry = (post: Post): IngestedEntry => ({
  guid: post.url,
  url: post.url,
  title: post.url,
  summary: post.listDate,
  contentHtml: null,
  author: null,
  publishedAt: null,
})
const answer = (url: string, text = "", status = 200) => ({
  url,
  text,
  status,
  headers: new Headers({ "retry-after": "120" }),
  kind: "unknown" as const,
})

function run(fetch: SafeFetch, known = new Set<string>()) {
  return fetchListThenPosts(
    {
      url: LIST,
      fetch,
      deadline: new AbortController().signal,
      known: async () => known,
    },
    {
      listUrl: LIST,
      links: ($, pageUrl) =>
        $("a")
          .map((_, a) => ({
            url: new URL($(a).attr("href")!, pageUrl).href,
            listDate: $(a).attr("data-date") ?? null,
          }))
          .get(),
      readPost: (_, post) => entry(post),
    }
  )
}

describe("list-posts independent regression coverage", () => {
  test("backfills exactly the newest 30 across three runs then stops", async () => {
    const links = Array.from(
      { length: 531 },
      (_, i) => `<a href="/post/${i}">Post ${i}</a>`
    ).join("")
    const known = new Set<string>()
    const calls: string[] = []
    const fetch: SafeFetch = async (url) => {
      calls.push(url)
      return answer(url, url === LIST ? links : "post")
    }
    for (let i = 0; i < 3; i++) {
      const entries = await run(fetch, known)
      expect(entries.map((item) => item.url)).toEqual(
        Array.from(
          { length: 10 },
          (_, j) => `https://example.test/post/${i * 10 + j}`
        )
      )
      for (const item of entries) known.add(item.guid)
    }
    expect(await run(fetch, known)).toEqual([])
    expect(known.size).toBe(30)
    expect(calls.filter((url) => url !== LIST)).toHaveLength(30)
    expect(calls).toHaveLength(34)
  })

  test("uses the final list URL for relative links and preserves list metadata", async () => {
    const fetch: SafeFetch = async (url) =>
      url === LIST
        ? answer(
            "https://redirect.test/news/",
            '<a href="new" data-date="2026-10-22">New</a>'
          )
        : answer(url)
    const entries = await run(fetch)
    expect(entries).toEqual([
      entry({
        url: "https://redirect.test/news/new",
        listDate: "2026-10-22",
      }),
    ])
  })

  test("keeps document order when post responses finish in reverse order", async () => {
    const pending = new Map<
      string,
      (value: ReturnType<typeof answer>) => void
    >()
    let allStarted!: () => void
    const started = new Promise<void>((resolve) => {
      allStarted = resolve
    })
    const fetch: SafeFetch = async (url) => {
      if (url === LIST)
        return answer(
          url,
          '<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>'
        )
      return new Promise((resolve) => {
        pending.set(url, resolve)
        if (pending.size === 3) allStarted()
      })
    }
    const result = run(fetch)
    await started
    for (const [url, resolve] of [...pending].reverse()) resolve(answer(url))
    expect((await result).map((item) => item.url)).toEqual(
      ["a", "b", "c"].map((slug) => `https://example.test/${slug}`)
    )
  })

  for (const status of [304, 404, 429, 500]) {
    test(`list status ${status} preserves status and Retry-After`, async () => {
      const error = await run(async (url) => answer(url, "", status)).catch(
        (error) => error
      )
      expect(error).toBeInstanceOf(SourceStatusError)
      expect(error.status).toBe(status)
      expect(error.headers.get("retry-after")).toBe("120")
    })

    test(`all posts answering ${status} is an unreadable failure`, async () => {
      const fetch: SafeFetch = async (url) =>
        url === LIST
          ? answer(url, '<a href="/a">A</a>')
          : answer(url, "", status)
      await expect(run(fetch)).rejects.toThrow(NONE_READ)
    })
  }
})
