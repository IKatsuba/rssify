import { readFileSync } from "node:fs"

import { beforeEach, describe, expect, test } from "bun:test"

import type { SourcePlugin } from "@/sources/types"
import { db } from "@/test/db"

import type { IngestedEntry } from "./ingest/parse"
import {
  SafeFetchError,
  type SafeFetch,
  type SafeFetchOptions,
  type SafeFetchResult,
} from "./ingest/safe-fetch"
import { subscribe, SUBSCRIPTION_LIMIT } from "./reader"

const NOW = new Date("2026-03-01T12:00:00Z")
const HOUR = 3_600_000
const FEED = "https://blog.example.com/feed.xml"
const PAGE = "https://blog.example.com/"

const fixture = (name: string) =>
  readFileSync(`test/fixtures/feeds/${name}`, "utf8")

type Item = { guid: string; date?: Date; link?: string }

function rss(items: Item[], title = "Example blog") {
  const body = items
    .map(
      (i) =>
        `<item><guid isPermaLink="false">${i.guid}</guid><title>${i.guid}</title>` +
        (i.link ? `<link>${i.link}</link>` : "") +
        (i.date ? `<pubDate>${i.date.toUTCString()}</pubDate>` : "") +
        `</item>`
    )
    .join("")
  return (
    `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>` +
    `<link>/home</link>${body}</channel></rss>`
  )
}

function html(...feeds: string[]) {
  const links = feeds
    .map(
      (href) =>
        `<link rel="alternate" type="application/rss+xml" href="${href}">`
    )
    .join("")
  return `<!DOCTYPE html><html><head>${links}</head><body>Hi</body></html>`
}

type Answer =
  Error | (Partial<SafeFetchResult> & { text?: string; headers?: Headers })

// A fake fetch answering from a table; an unknown URL fails the test.
function site(table: Record<string, Answer>) {
  const calls: { url: string; options?: SafeFetchOptions }[] = []
  const fetch: SafeFetch = async (url, options) => {
    calls.push({ url, options })
    const answer = table[url]
    if (!answer) throw new Error(`unexpected fetch of ${url}`)
    if (answer instanceof Error) throw answer
    return {
      status: 200,
      url,
      headers: new Headers(),
      text: "",
      kind: "xml",
      ...answer,
    }
  }
  return { fetch, calls }
}

const noFetch: SafeFetch = async (url) => {
  throw new Error(`unexpected fetch of ${url}`)
}

async function user(id: string) {
  await db.user.create({ data: { id, name: id, email: `${id}@example.com` } })
}

async function nothingWritten() {
  expect(await db.feed.count()).toBe(0)
  expect(await db.entry.count()).toBe(0)
  expect(await db.subscription.count()).toBe(0)
}

beforeEach(async () => {
  await user("u1")
  await user("u2")
})

describe("subscribe to a new feed", () => {
  test("an existing feed subscribes without a fetch", async () => {
    const feed = await db.feed.create({ data: { url: FEED } })
    expect(await subscribe("u1", { url: FEED }, { fetch: noFetch })).toEqual({
      ok: true,
      feedId: feed.id,
      existed: false,
    })
  })

  test("stores the feed, its first entries and the success polling fields", async () => {
    const items: Item[] = Array.from({ length: 101 }, (_, i) => ({
      guid: `g${i}`,
      date: new Date(NOW.getTime() - (i + 1) * HOUR),
      link: `/posts/${i}`,
    }))
    items.push({ guid: "future", date: new Date(NOW.getTime() + HOUR) })
    const { fetch, calls } = site({
      [FEED]: {
        // Redirected: links resolve against the final URL, but the stored
        // URL stays the one added.
        url: "https://cdn.example.net/feed.xml",
        text: rss(items),
        headers: new Headers({
          etag: '"v1"',
          "last-modified": "Sun, 01 Mar 2026 10:00:00 GMT",
        }),
      },
    })
    const result = await subscribe(
      "u1",
      { url: ` ${FEED}#x` },
      { fetch, now: NOW }
    )
    expect(result).toMatchObject({ ok: true, existed: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].options?.deadline).toBeInstanceOf(AbortSignal)

    const feed = await db.feed.findUniqueOrThrow({ where: { url: FEED } })
    expect(feed).toMatchObject({
      id: (result as { feedId: string }).feedId,
      pluginId: null,
      title: "Example blog",
      siteUrl: "https://cdn.example.net/home",
      status: "ok",
      lastFetchedAt: NOW,
      lastSuccessAt: NOW,
      nextFetchAt: new Date(NOW.getTime() + HOUR),
      failureCount: 0,
      lastError: null,
      etag: '"v1"',
      lastModified: "Sun, 01 Mar 2026 10:00:00 GMT",
    })
    const entries = await db.entry.findMany({
      where: { feedId: feed.id },
      orderBy: [{ sortAt: "desc" }, { id: "desc" }],
    })
    // Newest 100 of 102 items: future and g0..g98.
    expect(entries).toHaveLength(100)
    expect(entries[0]).toMatchObject({
      guid: "future",
      sortAt: NOW,
      createdAt: NOW,
    })
    const g0 = entries.find((e) => e.guid === "g0")
    expect(g0?.url).toBe("https://cdn.example.net/posts/0")
    expect(g0?.sortAt).toEqual(new Date(NOW.getTime() - HOUR))
    expect(entries.some((e) => e.guid === "g99")).toBe(false)
    expect(
      await db.subscription.count({ where: { userId: "u1", feedId: feed.id } })
    ).toBe(1)
  })

  test("writes the feed, entries and subscription in one transaction", async () => {
    // No such user: the subscription insert fails after the feed and its
    // entries, and must take them with it.
    const { fetch } = site({ [FEED]: { text: rss([{ guid: "a" }]) } })
    expect(
      subscribe("ghost", { url: FEED }, { fetch, now: NOW })
    ).rejects.toThrow()
    await Bun.sleep(0)
    await nothingWritten()
  })

  describe("a failed first fetch returns its code and writes nothing", () => {
    const cases: [string, Answer, string][] = [
      ["invalid_url", new SafeFetchError("invalid_url", "x"), "invalid_url"],
      ["blocked", new SafeFetchError("blocked", "x"), "blocked"],
      ["unreachable", new SafeFetchError("unreachable", "x"), "unreachable"],
      ["too_large", new SafeFetchError("too_large", "x"), "too_large"],
      ["404", { status: 404 }, "not_found"],
      ["410", { status: 410 }, "not_found"],
      ["403", { status: 403 }, "unreachable"],
      ["500", { status: 500 }, "unreachable"],
      ["304", { status: 304 }, "unreachable"],
      ["plain text", { text: "hello" }, "not_found"],
      [
        "XML that is not a feed",
        { text: '<?xml version="1.0"?><note>hi</note>' },
        "not_found",
      ],
      [
        "JSON that is not a feed",
        { text: '{"a":1}', kind: "json" },
        "not_found",
      ],
      [
        "HTML without feed links",
        { text: fixture("cursor-blog.html") },
        "not_found",
      ],
    ]
    for (const [name, answer, code] of cases) {
      test(name, async () => {
        const { fetch } = site({ [FEED]: answer })
        expect(
          await subscribe("u1", { url: FEED }, { fetch, now: NOW })
        ).toEqual({
          ok: false,
          code,
        })
        await nothingWritten()
      })
    }

    test("a non-fetch error is ours and throws", async () => {
      const { fetch } = site({ [FEED]: new TypeError("bug") })
      await expect(subscribe("u1", { url: FEED }, { fetch })).rejects.toThrow(
        "bug"
      )
      await nothingWritten()
    })
  })

  test("not a URL → invalid_url without a fetch", async () => {
    expect(
      await subscribe("u1", { url: "ftp://x" }, { fetch: noFetch })
    ).toEqual({
      ok: false,
      code: "invalid_url",
    })
  })

  test("an HTML page with one feed link stores the discovered URL", async () => {
    const discovered = "https://blog.example.com/rss.xml"
    const { fetch, calls } = site({
      [PAGE]: { text: html("/rss.xml#top") },
      [discovered]: { text: rss([{ guid: "a" }]) },
    })
    const result = await subscribe("u1", { url: PAGE }, { fetch, now: NOW })
    expect(result).toMatchObject({ ok: true, existed: false })
    expect(calls.map((c) => c.url)).toEqual([PAGE, discovered])
    const feed = await db.feed.findUniqueOrThrow({ where: { url: discovered } })
    expect(await db.entry.count({ where: { feedId: feed.id } })).toBe(1)
    expect(await db.feed.count()).toBe(1)
  })

  test("discovery runs on an HTML Content-Type without a doctype", async () => {
    const discovered = "https://blog.example.com/rss.xml"
    const { fetch } = site({
      [PAGE]: {
        text: '<head><link rel="alternate" type="application/rss+xml" href="/rss.xml"></head>',
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      },
      [discovered]: { text: rss([]) },
    })
    expect(
      await subscribe("u1", { url: PAGE }, { fetch, now: NOW })
    ).toMatchObject({
      ok: true,
    })
  })

  test("several feed links → multiple; a second call with one choice subscribes", async () => {
    const { fetch } = site({
      [PAGE]: { text: html("/rss.xml", "/atom.xml", "/rss.xml") },
      "https://blog.example.com/atom.xml": {
        text:
          '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">' +
          "<title>Atom blog</title></feed>",
      },
    })
    const first = await subscribe("u1", { url: PAGE }, { fetch, now: NOW })
    expect(first).toEqual({
      ok: false,
      code: "multiple",
      choices: [
        "https://blog.example.com/rss.xml",
        "https://blog.example.com/atom.xml",
      ],
    })
    await nothingWritten()
    const second = await subscribe(
      "u1",
      { url: first.ok ? "" : first.choices![1] },
      {
        fetch,
        now: NOW,
      }
    )
    expect(second).toMatchObject({ ok: true, existed: false })
    expect(
      await db.feed.findUniqueOrThrow({
        where: { url: "https://blog.example.com/atom.xml" },
      })
    ).toMatchObject({ title: "Atom blog" })
  })

  test("a discovered URL already stored subscribes without a second fetch", async () => {
    const stored = await db.feed.create({
      data: { url: "https://blog.example.com/rss.xml" },
    })
    const { fetch, calls } = site({ [PAGE]: { text: html("/rss.xml") } })
    expect(await subscribe("u1", { url: PAGE }, { fetch, now: NOW })).toEqual({
      ok: true,
      feedId: stored.id,
      existed: false,
    })
    expect(calls).toHaveLength(1)
  })

  test("a discovered URL answering HTML is not followed further", async () => {
    const discovered = "https://blog.example.com/rss.xml"
    const { fetch, calls } = site({
      [PAGE]: { text: html("/rss.xml") },
      [discovered]: { text: html("/other.xml") },
    })
    expect(await subscribe("u1", { url: PAGE }, { fetch, now: NOW })).toEqual({
      ok: false,
      code: "not_found",
    })
    expect(calls).toHaveLength(2)
    await nothingWritten()
  })

  test("a discovered URL that fails returns its code", async () => {
    const { fetch } = site({
      [PAGE]: { text: html("/rss.xml") },
      "https://blog.example.com/rss.xml": new SafeFetchError("blocked", "x"),
    })
    expect(await subscribe("u1", { url: PAGE }, { fetch, now: NOW })).toEqual({
      ok: false,
      code: "blocked",
    })
    await nothingWritten()
  })

  test("a built-in source subscribes to its feed URL", async () => {
    const { fetch, calls } = site({
      "https://claude.dev/rss.xml": { text: fixture("claude-dev.rss.xml") },
    })
    const result = await subscribe(
      "u1",
      { source: "claude-code" },
      { fetch, now: NOW }
    )
    expect(result).toMatchObject({ ok: true, existed: false })
    expect(calls.map((c) => c.url)).toEqual(["https://claude.dev/rss.xml"])
    const feed = await db.feed.findUniqueOrThrow({
      where: { url: "https://claude.dev/rss.xml" },
    })
    expect(feed).toMatchObject({ pluginId: null, title: "claude.dev Blog" })
    expect(await db.entry.count({ where: { feedId: feed.id } })).toBe(16)
  })

  test("an unknown source → not_found without a fetch", async () => {
    expect(
      await subscribe("u1", { source: "nope" }, { fetch: noFetch })
    ).toEqual({
      ok: false,
      code: "not_found",
    })
  })

  describe("a URL a plugin matches runs the plugin", () => {
    const LIST = "https://scrape.example.com/blog"
    const post: IngestedEntry = {
      guid: "https://scrape.example.com/blog/one",
      url: "https://scrape.example.com/blog/one",
      title: "One",
      author: null,
      publishedAt: new Date(NOW.getTime() - HOUR),
      summary: null,
      contentHtml: "<p>One</p>",
    }
    const plugin = (fetchEntries: SourcePlugin["fetchEntries"]) => ({
      scrape: { id: "scrape", matches: LIST, fetchEntries },
    })

    test("stores its entries with pluginId and no fetch of its own", async () => {
      let ctx: Parameters<SourcePlugin["fetchEntries"]>[0] | undefined
      const plugins = plugin(async (c) => {
        ctx = c
        return [post]
      })
      const result = await subscribe(
        "u1",
        { url: LIST },
        { fetch: noFetch, plugins, now: NOW }
      )
      expect(result).toMatchObject({ ok: true, existed: false })
      expect(ctx?.fetch).toBe(noFetch)
      expect(ctx?.deadline).toBeInstanceOf(AbortSignal)
      expect(await ctx?.known([post.url!])).toEqual(new Set())
      const feed = await db.feed.findUniqueOrThrow({ where: { url: LIST } })
      expect(feed).toMatchObject({
        pluginId: "scrape",
        title: null,
        siteUrl: LIST,
        etag: null,
        lastSuccessAt: NOW,
      })
      expect(await db.entry.count({ where: { feedId: feed.id } })).toBe(1)
    })

    const failures: [string, SourcePlugin["fetchEntries"], string][] = [
      [
        "a fetch error keeps its code",
        async () => {
          throw new SafeFetchError("too_large", "x")
        },
        "too_large",
      ],
      [
        "any other throw → not_found",
        async () => {
          throw new Error("layout")
        },
        "not_found",
      ],
      ["0 entries → not_found", async () => [], "not_found"],
    ]
    for (const [name, fetchEntries, code] of failures) {
      test(name, async () => {
        expect(
          await subscribe(
            "u1",
            { url: LIST },
            { fetch: noFetch, plugins: plugin(fetchEntries) }
          )
        ).toEqual({ ok: false, code })
        await nothingWritten()
      })
    }
  })

  test("two users adding one new URL at once share one feed", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let arrived = 0
    const items = [{ guid: "a" }, { guid: "b" }]
    const fetch: SafeFetch = async (url) => {
      arrived++
      await gate
      return {
        status: 200,
        url,
        headers: new Headers(),
        text: rss(items),
        kind: "xml",
      }
    }
    const first = subscribe("u1", { url: FEED }, { fetch, now: NOW })
    const second = subscribe("u2", { url: FEED }, { fetch, now: NOW })
    // Both have looked for the feed and are fetching before either stores.
    while (arrived < 2) await Bun.sleep(5)
    release()
    const results = await Promise.all([first, second])
    expect(results.map((r) => r.ok)).toEqual([true, true])
    const [a, b] = results as { feedId: string; existed: boolean }[]
    expect(a.feedId).toBe(b.feedId)
    expect(a.existed || b.existed).toBe(false)
    expect(await db.feed.count()).toBe(1)
    expect(await db.entry.count()).toBe(2)
    expect(await db.subscription.count({ where: { feedId: a.feedId } })).toBe(2)
  })

  describe("the cap", () => {
    async function fill(n: number) {
      await db.feed.createMany({
        data: Array.from({ length: n }, (_, i) => ({
          id: `f${i}`,
          url: `https://f${i}.example.com/`,
        })),
      })
      await db.subscription.createMany({
        data: Array.from({ length: n }, (_, i) => ({
          userId: "u1",
          feedId: `f${i}`,
        })),
      })
    }

    test("at 500 → limit before any fetch", async () => {
      await fill(SUBSCRIPTION_LIMIT)
      expect(await subscribe("u1", { url: FEED }, { fetch: noFetch })).toEqual({
        ok: false,
        code: "limit",
      })
      expect(await db.feed.count()).toBe(SUBSCRIPTION_LIMIT)
    })

    test("reaching 500 during the fetch → limit, nothing written", async () => {
      await fill(SUBSCRIPTION_LIMIT - 1)
      const fetch: SafeFetch = async (url) => {
        await db.feed.create({
          data: { id: "late", url: "https://late.example.com/" },
        })
        await db.subscription.create({ data: { userId: "u1", feedId: "late" } })
        return {
          status: 200,
          url,
          headers: new Headers(),
          text: rss([{ guid: "a" }]),
          kind: "xml",
        }
      }
      expect(await subscribe("u1", { url: FEED }, { fetch, now: NOW })).toEqual(
        {
          ok: false,
          code: "limit",
        }
      )
      expect(await db.feed.count({ where: { url: FEED } })).toBe(0)
      expect(await db.entry.count()).toBe(0)
    })
  })
})
