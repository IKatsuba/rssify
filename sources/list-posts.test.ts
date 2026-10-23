import { describe, expect, test } from "bun:test"

import { SafeFetchError, type SafeFetch } from "@/lib/ingest/safe-fetch"

import {
  fetchListThenPosts,
  LAYOUT_CHANGED,
  NONE_READ,
  type Post,
} from "./list-posts"
import { SourceStatusError } from "./types"

const LIST = "https://example.com/blog"
const post = (slug: string) => `${LIST}/${slug}`
const list = (slugs: string[]) =>
  slugs.map((slug) => `<a href="/blog/${slug}">${slug}</a>`).join("")
const slugs = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`)

// A post page is its title; the stand-in readPost returns null without one.
const titled = (title: string) => ({ text: `<title>${title}</title>` })

const TIMEOUT = () => new SafeFetchError("unreachable", "the server took too long")

type Answer =
  | { status?: number; text?: string; headers?: HeadersInit }
  | Error
  // Waits until the deadline aborts, as safe-fetch would, then fails.
  | "hang"

function site(pages: Record<string, Answer>, onCall?: (url: string) => void) {
  const calls: string[] = []
  const signals: (AbortSignal | undefined)[] = []
  let inFlight = 0
  let maxInFlight = 0
  const fetch: SafeFetch = async (url, options) => {
    calls.push(url)
    signals.push(options?.deadline)
    onCall?.(url)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      await Bun.sleep(1)
      const page = pages[url] ?? { status: 404 }
      if (page === "hang") {
        const deadline = options!.deadline!
        if (!deadline.aborted) {
          await new Promise((resolve) =>
            deadline.addEventListener("abort", resolve)
          )
        }
        throw TIMEOUT()
      }
      if (page instanceof Error) throw page
      return {
        status: page.status ?? 200,
        url,
        headers: new Headers(page.headers),
        text: page.text ?? "",
        kind: "unknown",
      }
    } finally {
      inFlight--
    }
  }
  return {
    fetch,
    calls,
    signals,
    get maxInFlight() {
      return maxInFlight
    },
  }
}

function run(
  fetch: SafeFetch,
  {
    known = [] as string[],
    deadline = new AbortController().signal,
    asked = [] as string[][],
    lookup,
  }: {
    known?: string[]
    deadline?: AbortSignal
    asked?: string[][]
    lookup?: (urls: string[]) => Promise<Set<string>>
  } = {}
) {
  return fetchListThenPosts(
    {
      url: LIST,
      fetch,
      known:
        lookup ??
        (async (urls) => {
          asked.push(urls)
          return new Set(urls.filter((url) => known.includes(url)))
        }),
      deadline,
    },
    {
      listUrl: LIST,
      links: ($, pageUrl) =>
        $("a[href]")
          .map((_, a): Post => ({
            url: new URL($(a).attr("href")!, pageUrl).href,
            listDate: null,
          }))
          .get(),
      readPost: (html, p) => {
        const title = /<title>(.*)<\/title>/.exec(html)?.[1]
        return title
          ? {
              guid: p.url,
              url: p.url,
              title,
              author: null,
              summary: null,
              contentHtml: null,
              publishedAt: null,
            }
          : null
      },
    }
  )
}

describe("fetchListThenPosts", () => {
  test("an empty list is a layout change", async () => {
    const s = site({ [LIST]: { text: "<main>client-rendered</main>" } })
    expect(run(s.fetch)).rejects.toThrow(LAYOUT_CHANGED)
  })

  test("a non-2xx list throws its status and headers", async () => {
    const s = site({ [LIST]: { status: 503, headers: { "retry-after": "60" } } })
    const error = await run(s.fetch).catch((e) => e)
    expect(error).toBeInstanceOf(SourceStatusError)
    expect(error.status).toBe(503)
    expect(error.headers.get("retry-after")).toBe("60")
    expect(s.calls).toEqual([LIST])
  })

  test("all known is an empty success with no post fetched", async () => {
    const s = site({ [LIST]: { text: list(["a", "b"]) } })
    const entries = await run(s.fetch, { known: [post("a"), post("b")] })
    expect(entries).toEqual([])
    expect(s.calls).toEqual([LIST])
  })

  test("reads unknown posts in document order, 10 at most, 4 at a time", async () => {
    const all = slugs(14)
    const pages: Record<string, Answer> = { [LIST]: { text: list(all) } }
    for (const slug of all) pages[post(slug)] = titled(slug)
    const s = site(pages)
    const deadline = new AbortController().signal
    const entries = await run(s.fetch, { known: [post("p1")], deadline })

    const expected = all.filter((slug) => slug !== "p1").slice(0, 10)
    expect(entries.map((e) => e.title)).toEqual(expected)
    expect(s.calls.slice(1).sort()).toEqual(expected.map(post).sort())
    expect(s.maxInFlight).toBe(4)
    expect(s.signals.every((signal) => signal === deadline)).toBe(true)
  })

  test("only the first 30 links are candidates", async () => {
    const all = slugs(531)
    const s = site({ [LIST]: { text: list(all) } })
    const asked: string[][] = []
    const known = all.slice(0, 30).map(post)
    // Link 31 onwards is unknown, but never a candidate.
    expect(await run(s.fetch, { known, asked })).toEqual([])
    expect(asked).toEqual([known])
    expect(s.calls).toEqual([LIST])
  })

  test("partial success is success", async () => {
    const s = site({
      [LIST]: { text: list(["ok", "down", "gone", "notpost"]) },
      [post("ok")]: titled("Fine"),
      [post("down")]: new SafeFetchError("unreachable", "down"),
      [post("gone")]: { status: 500 },
      [post("notpost")]: { text: "<p>no title</p>" },
    })
    const entries = await run(s.fetch)
    expect(entries.map((e) => e.url)).toEqual([post("ok")])
  })

  test("every unknown post unreadable throws", async () => {
    for (const answer of [
      { status: 404 },
      new SafeFetchError("unreachable", "down"),
      { text: "<p>no title</p>" },
    ] satisfies Answer[]) {
      const s = site({
        [LIST]: { text: list(["a", "b", "c"]) },
        [post("a")]: answer,
        [post("b")]: answer,
      })
      const error = await run(s.fetch, { known: [post("c")] }).catch((e) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(SafeFetchError)
      expect(error.message).toBe(NONE_READ)
    }
  })

  test("a post that keeps failing does not block a newer one", async () => {
    // Ten old posts fail every run; a new one appears at the top.
    const old = slugs(10)
    const pages: Record<string, Answer> = {
      [LIST]: { text: list(["new", ...old]) },
      [post("new")]: titled("New"),
    }
    for (const slug of old) pages[post(slug)] = { status: 500 }
    const s = site(pages)
    const entries = await run(s.fetch)
    expect(entries.map((e) => e.url)).toEqual([post("new")])
    expect(s.calls).toHaveLength(11)
  })

  test("a deadline during the list starts no further request", async () => {
    const controller = new AbortController()
    let looked = false
    const s = site({ [LIST]: "hang" }, () =>
      setTimeout(() => controller.abort(), 5)
    )
    const error = await run(s.fetch, {
      deadline: controller.signal,
      lookup: async () => {
        looked = true
        return new Set()
      },
    }).catch((e) => e)
    expect(error).toBeInstanceOf(SafeFetchError)
    expect(error.message).toBe("the server took too long")
    expect(looked).toBe(false)
    expect(s.calls).toEqual([LIST])
  })

  test("a deadline during posts stops new requests and keeps what was read", async () => {
    const controller = new AbortController()
    const all = slugs(10)
    const pages: Record<string, Answer> = { [LIST]: { text: list(all) } }
    for (const slug of all) pages[post(slug)] = "hang"
    pages[post("p0")] = titled("First")
    // The deadline passes once the first four posts are in flight; p0
    // answers after it.
    const s = site(pages, () => {
      if (s.calls.length === 5) controller.abort()
    })
    const entries = await run(s.fetch, { deadline: controller.signal })
    expect(entries.map((e) => e.title)).toEqual(["First"])
    expect(s.calls).toEqual([LIST, ...all.slice(0, 4).map(post)])
  })

  test("a deadline with nothing read keeps the timeout text", async () => {
    const controller = new AbortController()
    const all = slugs(10)
    const pages: Record<string, Answer> = { [LIST]: { text: list(all) } }
    for (const slug of all) pages[post(slug)] = "hang"
    const s = site(pages, () => {
      if (s.calls.length === 5) controller.abort()
    })
    const error = await run(s.fetch, { deadline: controller.signal }).catch(
      (e) => e
    )
    expect(error).toBeInstanceOf(SafeFetchError)
    expect(error.message).toBe("the server took too long")
    expect(s.calls).toHaveLength(5)
  })

  test("a deadline before any post starts is the all-failed error", async () => {
    const controller = new AbortController()
    const s = site({ [LIST]: { text: list(["a"]) } })
    const error = await run(s.fetch, {
      deadline: controller.signal,
      lookup: async () => {
        controller.abort()
        return new Set()
      },
    }).catch((e) => e)
    expect(error.message).toBe(NONE_READ)
    expect(s.calls).toEqual([LIST])
  })

  test("a DB error in known() throws", async () => {
    const s = site({ [LIST]: { text: list(["a"]) } })
    const db = new Error("connection lost")
    const error = await run(s.fetch, {
      lookup: async () => {
        throw db
      },
    }).catch((e) => e)
    expect(error).toBe(db)
    expect(s.calls).toEqual([LIST])
  })

  test("a post fetch error that is not a SafeFetchError throws", async () => {
    const bug = new TypeError("bug")
    const s = site({
      [LIST]: { text: list(["a", "b"]) },
      [post("a")]: titled("A"),
      [post("b")]: bug,
    })
    expect(run(s.fetch)).rejects.toBe(bug)
  })
})
