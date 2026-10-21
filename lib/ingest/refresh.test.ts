import { readFileSync } from "node:fs"

import { describe, expect, test } from "bun:test"

import { SourceStatusError, type SourcePlugin } from "@/sources/types"
import { db } from "@/test/db"

import type { IngestedEntry } from "./parse"

import {
  backoff,
  fetchErrorText,
  LAST_ERROR,
  refreshFeed,
  retryAfterMs,
} from "./refresh"
import {
  SafeFetchError,
  type SafeFetch,
  type SafeFetchOptions,
} from "./safe-fetch"

const NOW = new Date("2026-03-01T12:00:00Z")
const MIN = 60_000
const HOUR = 60 * MIN
const URL = "https://blog.example.com/feed.xml"

type Item = { guid: string; title?: string; date?: Date }

function rss(items: Item[], title = "Example blog") {
  const body = items
    .map(
      (i) =>
        `<item><guid isPermaLink="false">${i.guid}</guid>` +
        `<title>${i.title ?? i.guid}</title>` +
        (i.date ? `<pubDate>${i.date.toUTCString()}</pubDate>` : "") +
        `</item>`
    )
    .join("")
  return (
    `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>` +
    `<link>https://blog.example.com/</link>${body}</channel></rss>`
  )
}

function answer(
  status: number,
  text = "",
  headers: Record<string, string> = {}
) {
  const calls: { url: string; options?: SafeFetchOptions }[] = []
  const fetch: SafeFetch = async (url, options) => {
    calls.push({ url, options })
    return {
      status,
      url,
      headers: new Headers(headers),
      text,
      kind: "xml",
    }
  }
  return { fetch, calls }
}

function throwing(error: Error): SafeFetch {
  return async () => {
    throw error
  }
}

async function feed(data: Record<string, unknown> = {}) {
  return db.feed.create({ data: { id: "f1", url: URL, ...data } })
}

const row = () => db.feed.findUniqueOrThrow({ where: { id: "f1" } })
const at = (ms: number) => new Date(NOW.getTime() + ms)
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR)

describe("refreshFeed", () => {
  test("a missing feed returns without fetching", async () => {
    const { fetch, calls } = answer(200, rss([]))
    expect(await refreshFeed("nope", { fetch, now: NOW })).toEqual({
      outcome: "missing",
    })
    expect(calls).toHaveLength(0)
  })

  test("skips a feed fetched within the window, not one older", async () => {
    await feed({ lastFetchedAt: at(-119_000) })
    const { fetch, calls } = answer(200, rss([]))
    expect(
      await refreshFeed("f1", { skipIfFreshWithin: 120, fetch, now: NOW })
    ).toEqual({ outcome: "skipped" })
    expect(calls).toHaveLength(0)

    await db.feed.update({
      where: { id: "f1" },
      data: { lastFetchedAt: at(-121_000) },
    })
    expect(
      (await refreshFeed("f1", { skipIfFreshWithin: 120, fetch, now: NOW }))
        .outcome
    ).toBe("ok")
    expect(calls).toHaveLength(1)
  })

  test("200 stores entries, feed metadata, validators and resets failures", async () => {
    await feed({
      status: "failing",
      failureCount: 4,
      lastError: "the site answered 500 Internal Server Error",
      etag: '"old"',
      lastModified: "old",
    })
    const { fetch, calls } = answer(
      200,
      rss([
        { guid: "a", date: hoursAgo(2) },
        { guid: "b", date: hoursAgo(1) },
      ]),
      { etag: '"v2"', "last-modified": "Sun, 01 Mar 2026 11:00:00 GMT" }
    )
    expect(await refreshFeed("f1", { fetch, now: NOW })).toEqual({
      outcome: "ok",
      stored: 2,
    })
    expect(calls[0].url).toBe(URL)
    expect(calls[0].options?.etag).toBe('"old"')
    expect(calls[0].options?.lastModified).toBe("old")
    expect(calls[0].options?.deadline).toBeInstanceOf(AbortSignal)

    expect(await row()).toMatchObject({
      url: URL,
      title: "Example blog",
      siteUrl: "https://blog.example.com/",
      status: "ok",
      failureCount: 0,
      lastError: null,
      lastFetchedAt: NOW,
      lastSuccessAt: NOW,
      nextFetchAt: at(HOUR),
      etag: '"v2"',
      lastModified: "Sun, 01 Mar 2026 11:00:00 GMT",
    })
    const entries = await db.entry.findMany({ orderBy: { sortAt: "desc" } })
    expect(entries.map((e) => [e.guid, e.sortAt, e.createdAt])).toEqual([
      ["b", hoursAgo(1), NOW],
      ["a", hoursAgo(2), NOW],
    ])
  })

  test("relative links resolve against the redirected URL; the stored URL stays", async () => {
    await feed()
    const body =
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Moved</title>` +
      `<link>/</link><item><guid>g</guid><title>t</title><link>posts/1</link>` +
      `<description>&lt;a href="/a"&gt;a&lt;/a&gt;&lt;img src="/i.png"&gt;</description>` +
      `</item></channel></rss>`
    const fetch: SafeFetch = async () => ({
      status: 200,
      url: "https://new.example/news/feed.xml",
      headers: new Headers(),
      text: body,
      kind: "xml",
    })
    await refreshFeed("f1", { fetch, now: NOW })
    expect(await row()).toMatchObject({
      url: URL,
      siteUrl: "https://new.example/",
    })
    const entry = await db.entry.findFirstOrThrow()
    expect(entry.url).toBe("https://new.example/news/posts/1")
    expect(entry.contentHtml).toContain('href="https://new.example/a"')
    expect(entry.contentHtml).toContain('src="https://new.example/i.png"')
  })

  test("undated and future entries sort at now", async () => {
    await feed()
    const { fetch } = answer(
      200,
      rss([{ guid: "undated" }, { guid: "future", date: at(HOUR) }])
    )
    await refreshFeed("f1", { fetch, now: NOW })
    const entries = await db.entry.findMany({ orderBy: { guid: "asc" } })
    expect(entries.map((e) => [e.guid, e.publishedAt, e.sortAt])).toEqual([
      ["future", at(HOUR), NOW],
      ["undated", null, NOW],
    ])
  })

  test("the first version of an entry wins and read marks stay", async () => {
    await feed()
    await db.user.create({
      data: { id: "u1", name: "u1", email: "u1@example.com" },
    })
    const first = answer(200, rss([{ guid: "a", title: "First" }]))
    await refreshFeed("f1", { fetch: first.fetch, now: NOW })
    const entry = await db.entry.findFirstOrThrow()
    await db.readMark.create({ data: { userId: "u1", entryId: entry.id } })

    const second = answer(
      200,
      rss([
        { guid: "a", title: "Second" },
        { guid: "b", title: "New" },
      ])
    )
    expect(
      await refreshFeed("f1", { fetch: second.fetch, now: at(HOUR) })
    ).toEqual({ outcome: "ok", stored: 1 })
    const again = await db.entry.findUniqueOrThrow({ where: { id: entry.id } })
    expect(again.title).toBe("First")
    expect(again.createdAt).toEqual(NOW)
    expect(await db.readMark.count()).toBe(1)
  })

  test("takes only the newest 100 items of a fetch", async () => {
    await feed()
    // Document order is oldest first, so the newest are at the end.
    const items = Array.from({ length: 150 }, (_, i) => ({
      guid: `e${i}`,
      date: new Date(NOW.getTime() - (150 - i) * MIN),
    }))
    const { fetch } = answer(200, rss(items))
    expect(await refreshFeed("f1", { fetch, now: NOW })).toEqual({
      outcome: "ok",
      stored: 100,
    })
    const guids = (await db.entry.findMany()).map((e) => e.guid).sort()
    expect(guids).toEqual(
      Array.from({ length: 100 }, (_, i) => `e${i + 50}`).sort()
    )
  })

  test("equal times keep document order when cutting to 100", async () => {
    await feed()
    const items = Array.from({ length: 101 }, (_, i) => ({ guid: `u${i}` }))
    const { fetch } = answer(200, rss(items))
    await refreshFeed("f1", { fetch, now: NOW })
    expect(await db.entry.count()).toBe(100)
    expect(await db.entry.count({ where: { guid: "u100" } })).toBe(0)
  })

  test("retention keeps the newest 500 by sortAt then id", async () => {
    await feed()
    await db.entry.createMany({
      data: Array.from({ length: 499 }, (_, i) => ({
        id: `old${String(i).padStart(3, "0")}`,
        feedId: "f1",
        guid: `old${i}`,
        title: "old",
        sortAt: new Date(NOW.getTime() - (i + 10) * HOUR),
      })),
    })
    const { fetch } = answer(
      200,
      rss([
        { guid: "n1", date: hoursAgo(1) },
        { guid: "n2", date: hoursAgo(2) },
        { guid: "n3", date: hoursAgo(3) },
      ])
    )
    await refreshFeed("f1", { fetch, now: NOW })
    expect(await db.entry.count()).toBe(500)
    // The two oldest stored entries are the ones pruned.
    expect(
      await db.entry.count({ where: { id: { in: ["old498", "old497"] } } })
    ).toBe(0)
    expect(await db.entry.count({ where: { guid: "n3" } })).toBe(1)
  })

  test("retention is per feed", async () => {
    await feed()
    await db.feed.create({ data: { id: "f2", url: "https://other.example/" } })
    await db.entry.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        feedId: "f2",
        guid: `x${i}`,
        title: "x",
        sortAt: hoursAgo(i),
      })),
    })
    const { fetch } = answer(200, rss([{ guid: "a" }]))
    await refreshFeed("f1", { fetch, now: NOW })
    expect(await db.entry.count({ where: { feedId: "f2" } })).toBe(501)
  })

  test("304 keeps entries and validators, resets failures", async () => {
    await feed({
      failureCount: 3,
      status: "failing",
      lastError: "the feed is over 10 MB",
      etag: '"v1"',
      lastModified: "then",
      title: "Kept",
    })
    const { fetch } = answer(304)
    expect(await refreshFeed("f1", { fetch, now: NOW })).toEqual({
      outcome: "not_modified",
    })
    expect(await row()).toMatchObject({
      status: "ok",
      failureCount: 0,
      lastError: null,
      lastFetchedAt: NOW,
      lastSuccessAt: NOW,
      nextFetchAt: at(HOUR),
      etag: '"v1"',
      lastModified: "then",
      title: "Kept",
    })
  })

  test("304 takes new validators when the server sends them", async () => {
    await feed({ etag: '"v1"' })
    const { fetch } = answer(304, "", { etag: '"v2"' })
    await refreshFeed("f1", { fetch, now: NOW })
    expect((await row()).etag).toBe('"v2"')
  })

  test("410 marks the feed gone and stops polling", async () => {
    await feed({ failureCount: 2, lastSuccessAt: hoursAgo(5) })
    const { fetch } = answer(410)
    expect(await refreshFeed("f1", { fetch, now: NOW })).toEqual({
      outcome: "gone",
    })
    expect(await row()).toMatchObject({
      status: "gone",
      nextFetchAt: null,
      failureCount: 2,
      lastFetchedAt: NOW,
      lastSuccessAt: hoursAgo(5),
    })
  })

  test("failures back off and turn failing at the third", async () => {
    await feed({ lastSuccessAt: hoursAgo(5) })
    const { fetch } = answer(500)
    const expected = [
      [1, 2 * HOUR, "ok"],
      [2, 4 * HOUR, "ok"],
      [3, 8 * HOUR, "failing"],
      [4, 16 * HOUR, "failing"],
      [5, 24 * HOUR, "failing"],
      [6, 24 * HOUR, "failing"],
    ] as const
    for (const [count, delay, status] of expected) {
      expect(await refreshFeed("f1", { fetch, now: NOW })).toEqual({
        outcome: "failed",
        error: "the site answered 500 Internal Server Error",
      })
      expect(await row()).toMatchObject({
        failureCount: count,
        nextFetchAt: at(delay),
        status,
        lastFetchedAt: NOW,
        lastSuccessAt: hoursAgo(5),
        lastError: "the site answered 500 Internal Server Error",
      })
    }
  })

  test("a success after failing resets the feed", async () => {
    await feed()
    const failing = answer(404)
    for (let i = 0; i < 3; i++) {
      await refreshFeed("f1", { fetch: failing.fetch, now: NOW })
    }
    expect((await row()).status).toBe("failing")
    const ok = answer(200, rss([{ guid: "a" }]))
    await refreshFeed("f1", { fetch: ok.fetch, now: at(HOUR) })
    expect(await row()).toMatchObject({
      status: "ok",
      failureCount: 0,
      lastError: null,
      nextFetchAt: at(2 * HOUR),
    })
  })

  test("429 with Retry-After seconds waits the longer of it and backoff", async () => {
    await feed()
    const { fetch } = answer(429, "", { "retry-after": "18000" })
    expect(await refreshFeed("f1", { fetch, now: NOW })).toEqual({
      outcome: "failed",
      error: "the site answered 429 Too Many Requests",
    })
    expect(await row()).toMatchObject({
      failureCount: 1,
      nextFetchAt: at(5 * HOUR),
    })
  })

  test("503 with a short Retry-After date keeps the backoff", async () => {
    await feed()
    const { fetch } = answer(503, "", {
      "retry-after": at(10 * MIN).toUTCString(),
    })
    await refreshFeed("f1", { fetch, now: NOW })
    expect(await row()).toMatchObject({
      failureCount: 1,
      nextFetchAt: at(2 * HOUR),
      lastError: "the site answered 503 Service Unavailable",
    })
  })

  test("Retry-After is capped at 24 hours", async () => {
    await feed()
    const { fetch } = answer(429, "", { "retry-after": String(7 * 24 * 3600) })
    await refreshFeed("f1", { fetch, now: NOW })
    expect((await row()).nextFetchAt).toEqual(at(24 * HOUR))
  })

  test("Retry-After on another status is ignored", async () => {
    await feed()
    const { fetch } = answer(500, "", { "retry-after": "36000" })
    await refreshFeed("f1", { fetch, now: NOW })
    expect((await row()).nextFetchAt).toEqual(at(2 * HOUR))
  })

  test("a body that is not a feed is a failure", async () => {
    await feed()
    const { fetch } = answer(200, "<html><body>hi</body></html>")
    expect(await refreshFeed("f1", { fetch, now: NOW })).toEqual({
      outcome: "failed",
      error: "the response wasn’t a feed",
    })
    expect(await db.entry.count()).toBe(0)
  })

  test("safe-fetch errors become their sentences", async () => {
    await feed()
    const cases = [
      ["invalid_url", "the address isn’t allowed"],
      ["blocked", "the address isn’t allowed"],
      ["too_large", "the feed is over 10 MB"],
      ["unreachable", "the address couldn’t be found"],
    ] as const
    for (const [code, text] of cases) {
      const fetch = throwing(new SafeFetchError(code, "x"))
      expect(await refreshFeed("f1", { fetch, now: NOW })).toEqual({
        outcome: "failed",
        error: text,
      })
      expect((await row()).lastError).toBe(text)
    }
    expect((await row()).failureCount).toBe(4)
  })

  test("an unexpected fetch error throws and writes nothing", async () => {
    await feed()
    const fetch = throwing(new TypeError("bug"))
    await expect(refreshFeed("f1", { fetch, now: NOW })).rejects.toThrow("bug")
    expect((await row()).lastFetchedAt).toBeNull()
  })

  test("a database error throws and writes nothing", async () => {
    await feed()
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION refresh_test_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'refresh test failure'; END $$ LANGUAGE plpgsql`)
    await db.$executeRawUnsafe(`
      CREATE TRIGGER refresh_test_fail BEFORE UPDATE ON "Feed"
      FOR EACH ROW EXECUTE FUNCTION refresh_test_fail()`)
    try {
      const { fetch } = answer(200, rss([{ guid: "a" }]))
      await expect(refreshFeed("f1", { fetch, now: NOW })).rejects.toThrow()
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER refresh_test_fail ON "Feed"`)
      await db.$executeRawUnsafe(`DROP FUNCTION refresh_test_fail()`)
    }
    expect((await row()).lastFetchedAt).toBeNull()
    expect(await db.entry.count()).toBe(0)
    // So a redelivery is not skipped as a duplicate.
    const { fetch } = answer(200, rss([{ guid: "a" }]))
    expect(
      (await refreshFeed("f1", { skipIfFreshWithin: 120, fetch, now: NOW }))
        .outcome
    ).toBe("ok")
  })
})

describe("refreshFeed with a source plugin", () => {
  const LIST = "https://scrape.example.com/blog"
  const entry = (slug: string, hours = 1): IngestedEntry => ({
    guid: `${LIST}/${slug}`,
    url: `${LIST}/${slug}`,
    title: slug,
    author: null,
    publishedAt: hoursAgo(hours),
    summary: null,
    contentHtml: `<p>${slug}</p>`,
  })
  type Ctx = Parameters<SourcePlugin["fetchEntries"]>[0]
  const registry = (fetchEntries: SourcePlugin["fetchEntries"]) => ({
    scrape: { id: "scrape", matches: LIST, fetchEntries },
  })
  const pluginFeed = (data: Record<string, unknown> = {}) =>
    feed({ url: LIST, pluginId: "scrape", ...data })
  const throwingPlugin = (error: unknown) =>
    registry(async () => {
      throw error
    })
  const noFetch: SafeFetch = async (url) => {
    throw new Error(`unexpected fetch of ${url}`)
  }

  test("stores the plugin's entries with the success fields and no validators", async () => {
    await pluginFeed({
      status: "failing",
      failureCount: 4,
      lastError: "the page layout changed",
      title: "Scrape blog",
    })
    let ctx: Ctx | undefined
    const plugins = registry(async (c) => {
      ctx = c
      return [entry("a", 2), entry("b", 1)]
    })
    expect(
      await refreshFeed("f1", { fetch: noFetch, plugins, now: NOW })
    ).toEqual({ outcome: "ok", stored: 2 })
    expect(ctx?.fetch).toBe(noFetch)
    expect(ctx?.deadline).toBeInstanceOf(AbortSignal)
    expect(ctx?.deadline.aborted).toBe(false)
    expect(await row()).toMatchObject({
      url: LIST,
      title: "Scrape blog",
      status: "ok",
      failureCount: 0,
      lastError: null,
      lastFetchedAt: NOW,
      lastSuccessAt: NOW,
      nextFetchAt: at(HOUR),
      etag: null,
      lastModified: null,
    })
    const entries = await db.entry.findMany({ orderBy: { sortAt: "desc" } })
    expect(entries.map((e) => [e.guid, e.sortAt, e.createdAt])).toEqual([
      [`${LIST}/b`, hoursAgo(1), NOW],
      [`${LIST}/a`, hoursAgo(2), NOW],
    ])
  })

  test("known() names this feed's stored guids among the asked URLs", async () => {
    await pluginFeed()
    await db.feed.create({ data: { id: "f2", url: URL } })
    await db.entry.createMany({
      data: [
        { ...entry("a"), feedId: "f1", sortAt: NOW },
        { ...entry("b"), feedId: "f2", sortAt: NOW },
      ],
    })
    let known: Set<string> | undefined
    const plugins = registry(async (c) => {
      known = await c.known([`${LIST}/a`, `${LIST}/b`, `${LIST}/c`])
      return [entry("a"), entry("c")]
    })
    expect(
      await refreshFeed("f1", { fetch: noFetch, plugins, now: NOW })
    ).toEqual({ outcome: "ok", stored: 1 })
    expect(known).toEqual(new Set([`${LIST}/a`]))
  })

  test("no new posts is still a success", async () => {
    await pluginFeed({ failureCount: 1 })
    const plugins = registry(async () => [])
    expect(
      await refreshFeed("f1", { fetch: noFetch, plugins, now: NOW })
    ).toEqual({ outcome: "ok", stored: 0 })
    expect(await row()).toMatchObject({
      failureCount: 0,
      nextFetchAt: at(HOUR),
    })
  })

  test("an id the registry lacks is a source failure with backoff", async () => {
    for (const pluginId of ["retired", "constructor"]) {
      await db.feed.deleteMany()
      await pluginFeed({ pluginId })
      expect(
        await refreshFeed("f1", { fetch: noFetch, plugins: {}, now: NOW })
      ).toEqual({
        outcome: "failed",
        error: "the source isn’t supported any more",
      })
      expect(await row()).toMatchObject({
        failureCount: 1,
        nextFetchAt: at(2 * HOUR),
        lastFetchedAt: NOW,
        lastError: "the source isn’t supported any more",
      })
    }
  })

  test("a plugin's fetch errors become their sentences", async () => {
    await pluginFeed()
    const cases = [
      ["blocked", "the address isn’t allowed"],
      ["too_large", "the feed is over 10 MB"],
      ["unreachable", "the address couldn’t be found"],
    ] as const
    for (const [code, text] of cases) {
      const plugins = throwingPlugin(new SafeFetchError(code, "x"))
      expect(
        await refreshFeed("f1", { fetch: noFetch, plugins, now: NOW })
      ).toEqual({ outcome: "failed", error: text })
    }
    expect(await row()).toMatchObject({ failureCount: 3, status: "failing" })
  })

  test("a list page's 410 marks the feed gone", async () => {
    await pluginFeed()
    const plugins = throwingPlugin(new SourceStatusError(410, new Headers()))
    expect(
      await refreshFeed("f1", { fetch: noFetch, plugins, now: NOW })
    ).toEqual({ outcome: "gone" })
    expect(await row()).toMatchObject({
      status: "gone",
      nextFetchAt: null,
      lastFetchedAt: NOW,
    })
  })

  test("a list page's 429 honours Retry-After; other statuses back off", async () => {
    await pluginFeed()
    const limited = throwingPlugin(
      new SourceStatusError(429, new Headers({ "retry-after": "18000" }))
    )
    expect(
      await refreshFeed("f1", { fetch: noFetch, plugins: limited, now: NOW })
    ).toEqual({
      outcome: "failed",
      error: "the site answered 429 Too Many Requests",
    })
    expect(await row()).toMatchObject({
      failureCount: 1,
      nextFetchAt: at(5 * HOUR),
    })
    const broken = throwingPlugin(
      new SourceStatusError(500, new Headers({ "retry-after": "36000" }))
    )
    await refreshFeed("f1", { fetch: noFetch, plugins: broken, now: NOW })
    expect(await row()).toMatchObject({
      failureCount: 2,
      nextFetchAt: at(4 * HOUR),
      lastError: "the site answered 500 Internal Server Error",
    })
  })

  test("any other plugin throw is a failure with its message", async () => {
    await pluginFeed()
    const plugins = throwingPlugin(new Error("the page layout changed"))
    expect(
      await refreshFeed("f1", { fetch: noFetch, plugins, now: NOW })
    ).toEqual({ outcome: "failed", error: "the page layout changed" })
    expect(await row()).toMatchObject({
      failureCount: 1,
      lastError: "the page layout changed",
    })
  })

  test("a database error throws and writes nothing", async () => {
    await pluginFeed()
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION refresh_test_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'refresh test failure'; END $$ LANGUAGE plpgsql`)
    await db.$executeRawUnsafe(`
      CREATE TRIGGER refresh_test_fail BEFORE UPDATE ON "Feed"
      FOR EACH ROW EXECUTE FUNCTION refresh_test_fail()`)
    try {
      const plugins = registry(async () => [entry("a")])
      await expect(
        refreshFeed("f1", { fetch: noFetch, plugins, now: NOW })
      ).rejects.toThrow()
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER refresh_test_fail ON "Feed"`)
      await db.$executeRawUnsafe(`DROP FUNCTION refresh_test_fail()`)
    }
    expect((await row()).lastFetchedAt).toBeNull()
    expect(await db.entry.count()).toBe(0)
  })

  test("a database error in known() throws even when the plugin catches it", async () => {
    await pluginFeed()
    const plugins = registry(async (c) => {
      // An argument Prisma rejects stands in for a failing query.
      await c.known([42 as unknown as string]).catch(() => {})
      throw new Error("the page layout changed")
    })
    await expect(
      refreshFeed("f1", { fetch: noFetch, plugins, now: NOW })
    ).rejects.toThrow()
    expect((await row()).lastFetchedAt).toBeNull()
  })

  test("a database error in known() throws even when the plugin returns", async () => {
    await pluginFeed()
    const plugins = registry(async (c) => {
      await c.known([42 as unknown as string]).catch(() => new Set())
      return [entry("a")]
    })
    await expect(
      refreshFeed("f1", { fetch: noFetch, plugins, now: NOW })
    ).rejects.toThrow()
    expect((await row()).lastFetchedAt).toBeNull()
    expect(await db.entry.count()).toBe(0)
  })

  test("a cursor-blog feed runs the registered plugin on saved pages", async () => {
    const CURSOR = "https://cursor.com/blog"
    await feed({ url: CURSOR, pluginId: "cursor-blog" })
    const saved: Record<string, string> = {
      [CURSOR]: readFileSync("test/fixtures/feeds/cursor-blog.html", "utf8"),
      [`${CURSOR}/projects`]: readFileSync(
        "test/fixtures/cursor-blog/projects.html",
        "utf8"
      ),
    }
    // Already stored posts are not fetched again.
    await db.entry.create({
      data: {
        ...entry("x"),
        guid: `${CURSOR}/joining-spacex`,
        feedId: "f1",
        sortAt: NOW,
      },
    })
    const calls: string[] = []
    const fetch: SafeFetch = async (url) => {
      calls.push(url)
      return {
        status: saved[url] === undefined ? 404 : 200,
        url,
        headers: new Headers(),
        text: saved[url] ?? "",
        kind: "unknown",
      }
    }
    expect(await refreshFeed("f1", { fetch, now: NOW })).toEqual({
      outcome: "ok",
      stored: 1,
    })
    expect(calls).toHaveLength(11)
    expect(calls).not.toContain(`${CURSOR}/joining-spacex`)
    expect(
      await db.entry.findUniqueOrThrow({
        where: { feedId_guid: { feedId: "f1", guid: `${CURSOR}/projects` } },
      })
    ).toMatchObject({ title: "Introducing Projects" })
  })
})

describe("helpers", () => {
  test("backoff doubles from two hours to a 24-hour cap", () => {
    expect([1, 2, 3, 4, 5, 10].map((n) => backoff(n) / HOUR)).toEqual([
      2, 4, 8, 16, 24, 24,
    ])
  })

  test("a timed-out unreachable reads as no answer in time", () => {
    const error = new SafeFetchError("unreachable", "x")
    expect(fetchErrorText(error, true)).toBe(LAST_ERROR.timeout)
    expect(fetchErrorText(error, false)).toBe(LAST_ERROR.notFound)
    expect(LAST_ERROR.timeout).toBe("the site didn’t answer in time")
  })

  test("Retry-After reads seconds and HTTP-dates", () => {
    expect(retryAfterMs("120", NOW)).toBe(120_000)
    expect(retryAfterMs(at(HOUR).toUTCString(), NOW)).toBe(HOUR)
    expect(retryAfterMs(at(-HOUR).toUTCString(), NOW)).toBe(0)
    expect(retryAfterMs("soon", NOW)).toBeNull()
    expect(retryAfterMs(null, NOW)).toBeNull()
  })
})
