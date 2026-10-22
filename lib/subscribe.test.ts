import { readFileSync } from "node:fs"

import { beforeEach, describe, expect, test } from "bun:test"

import { SourceStatusError, type SourcePlugin } from "@/sources/types"
import { db } from "@/test/db"

import { fetchForAdd } from "./ingest/add"
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

  describe("an HTML body is sniffed past what precedes its root", () => {
    const discovered = "https://blog.example.com/rss.xml"
    const link =
      '<link rel="alternate" type="application/rss+xml" href="/rss.xml">'
    const bodies: [string, string, Headers][] = [
      [
        "leading comments, no Content-Type",
        `\uFEFF <!-- generated -->\n<!-- by x -->\n<!doctype html><html><head>${link}</head></html>`,
        new Headers(),
      ],
      [
        "XHTML with a prolog and a wrong Content-Type",
        `<?xml version="1.0" encoding="utf-8"?>\n<!-- c --><html xmlns="http://www.w3.org/1999/xhtml"><head>${link}</head></html>`,
        new Headers({ "content-type": "application/octet-stream" }),
      ],
      [
        "no <html>, starting with <head>",
        `<!-- c --><head>${link}</head><body></body>`,
        new Headers(),
      ],
      [
        "no <html>, starting with <META>",
        `<META charset="utf-8">${link}`,
        new Headers({ "content-type": "text/plain" }),
      ],
      [
        "no <html>, starting with <link/>",
        `${link.replace(">", "/>")}<title>Blog</title>`,
        new Headers(),
      ],
    ]
    for (const [name, text, headers] of bodies) {
      test(name, async () => {
        const { fetch, calls } = site({
          [PAGE]: { text, headers },
          [discovered]: { text: rss([]) },
        })
        expect(
          await subscribe("u1", { url: PAGE }, { fetch, now: NOW })
        ).toMatchObject({ ok: true })
        expect(calls.map((c) => c.url)).toEqual([PAGE, discovered])
      })
    }

    test("an unclosed comment or a non-HTML root is not a page", async () => {
      for (const text of [
        `<!-- never closed <html>${link}`,
        `<!-- c --><note>${link}</note>`,
        `<header>${link}</header>`,
        `<linkage>${link}</linkage>`,
      ]) {
        const { fetch, calls } = site({ [PAGE]: { text } })
        expect(
          await subscribe("u1", { url: PAGE }, { fetch, now: NOW })
        ).toEqual({ ok: false, code: "not_found" })
        expect(calls).toHaveLength(1)
      }
      await nothingWritten()
    })
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

  // The description is the whole text the feed gives, so it is both.
  test("langchain-blog subscribes to its summary-only feed", async () => {
    const url = "https://www.langchain.com/blog/rss.xml"
    const { fetch, calls } = site({
      [url]: { text: fixture("langchain-blog.rss.xml") },
    })
    const result = await subscribe(
      "u1",
      { source: "langchain-blog" },
      { fetch, now: NOW }
    )
    expect(result).toMatchObject({ ok: true, existed: false })
    expect(calls.map((c) => c.url)).toEqual([url])
    const feed = await db.feed.findUniqueOrThrow({ where: { url } })
    expect(feed).toMatchObject({ pluginId: null, title: "LangChain Blog" })
    const entries = await db.entry.findMany({ where: { feedId: feed.id } })
    expect(entries).toHaveLength(3)
    for (const entry of entries) {
      expect(entry.summary).not.toBeNull()
      expect(entry.contentHtml).toBe(entry.summary)
    }
  })

  describe("nodejs-blog", () => {
    const url = "https://nodejs.org/en/feed/blog.xml"
    const page = "https://nodejs.org/en/blog"
    const feedAnswer = { text: fixture("nodejs-blog.rss.xml") }

    test("subscribes to its feed, whose items carry no text", async () => {
      const { fetch, calls } = site({ [url]: feedAnswer })
      const result = await subscribe(
        "u1",
        { source: "nodejs-blog" },
        { fetch, now: NOW }
      )
      expect(result).toMatchObject({ ok: true, existed: false })
      expect(calls.map((c) => c.url)).toEqual([url])
      const feed = await db.feed.findUniqueOrThrow({ where: { url } })
      expect(feed).toMatchObject({ pluginId: null, title: "Node.js Blog" })
      const entries = await db.entry.findMany({ where: { feedId: feed.id } })
      expect(entries.map((e) => e.guid).sort()).toEqual([
        "/blog/release/v24.22.1?1792579154786",
        "/blog/release/v26.12.1?1792579160400",
        "/blog/vulnerability/october-2026-security-releases?1792620000000",
      ])
      for (const entry of entries) {
        expect(entry.summary).toBeNull()
        expect(entry.contentHtml).toBeNull()
      }
    })

    test("the pasted blog page lands on the built-in source's row", async () => {
      const { fetch, calls } = site({
        [page]: {
          text: fixture("nodejs-blog.html"),
          kind: "unknown",
          headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        },
        [url]: feedAnswer,
      })
      const pasted = await subscribe("u1", { url: page }, { fetch, now: NOW })
      expect(pasted).toMatchObject({ ok: true, existed: false })
      expect(calls.map((c) => c.url)).toEqual([page, url])

      const builtin = await subscribe(
        "u2",
        { source: "nodejs-blog" },
        { fetch: noFetch, now: NOW }
      )
      expect(builtin).toEqual({
        ok: true,
        feedId: pasted.ok ? pasted.feedId : "",
        existed: false,
      })
      expect(await db.feed.count()).toBe(1)
    })
  })

  test("an unknown source → not_found without a fetch", async () => {
    expect(
      await subscribe("u1", { source: "nope" }, { fetch: noFetch })
    ).toEqual({
      ok: false,
      code: "not_found",
    })
  })

  describe("cursor-blog through the registered plugin", () => {
    const LIST = "https://cursor.com/blog"
    const saved: Record<string, string> = {
      [LIST]: fixture("cursor-blog.html"),
      [`${LIST}/projects`]: readFileSync(
        "test/fixtures/cursor-blog/projects.html",
        "utf8"
      ),
      [`${LIST}/git-at-any-scale`]: readFileSync(
        "test/fixtures/cursor-blog/git-at-any-scale.html",
        "utf8"
      ),
    }
    // Saved pages answer; the other posts are skipped as 404s.
    const fetch: SafeFetch = async (url) => ({
      status: saved[url] === undefined ? 404 : 200,
      url,
      headers: new Headers(),
      text: saved[url] ?? "",
      kind: "unknown",
    })

    async function expectCursorFeed() {
      const feed = await db.feed.findUniqueOrThrow({ where: { url: LIST } })
      expect(feed).toMatchObject({
        pluginId: "cursor-blog",
        title: "Cursor blog",
        siteUrl: LIST,
        etag: null,
        lastModified: null,
        lastSuccessAt: NOW,
      })
      const entries = await db.entry.findMany({
        where: { feedId: feed.id },
        orderBy: { guid: "asc" },
      })
      expect(entries.map((e) => [e.guid, e.title])).toEqual([
        [`${LIST}/git-at-any-scale`, "Git at any scale"],
        [`${LIST}/projects`, "Introducing Projects"],
      ])
      expect(await db.subscription.count({ where: { feedId: feed.id } })).toBe(
        1
      )
    }

    test("the built-in source subscribes through the plugin", async () => {
      const result = await subscribe(
        "u1",
        { source: "cursor-blog" },
        { fetch, now: NOW }
      )
      expect(result).toMatchObject({ ok: true, existed: false })
      await expectCursorFeed()
    })

    test("its list URL matches the plugin", async () => {
      const result = await subscribe("u1", { url: LIST }, { fetch, now: NOW })
      expect(result).toMatchObject({ ok: true, existed: false })
      await expectCursorFeed()
    })

    test("every post answering 404 → not_found", async () => {
      const listOnly: SafeFetch = async (url) => ({
        status: url === LIST ? 200 : 404,
        url,
        headers: new Headers(),
        text: url === LIST ? saved[LIST] : "",
        kind: "unknown",
      })
      expect(await fetchForAdd(LIST, { fetch: listOnly })).toEqual({
        kind: "error",
        code: "not_found",
      })
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
      scrape: {
        id: "scrape",
        canonical: (u: URL) => (u.href === LIST ? LIST : null),
        fetchEntries,
      },
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
      expect(ctx?.url).toBe(LIST)
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

    describe("fetchForAdd", () => {
      // Owns the list page with or without a trailing slash.
      const titled = (title: string, seen: string[] = []): SourcePlugin => ({
        id: "scrape",
        canonical: (u) => (u.href.replace(/\/$/, "") === LIST ? LIST : null),
        title: (url) => `${title} ${url}`,
        fetchEntries: async (c) => {
          seen.push(c.url)
          return [post]
        },
      })

      test("titles the feed by the plugin and keeps its canonical URL", async () => {
        const seen: string[] = []
        expect(
          await fetchForAdd(`${LIST}/`, {
            fetch: noFetch,
            plugins: { scrape: titled("Scrape", seen) },
          })
        ).toMatchObject({
          kind: "feed",
          feed: { pluginId: "scrape", title: `Scrape ${LIST}`, siteUrl: LIST },
        })
        expect(seen).toEqual([LIST])
      })

      test("a built-in source's title wins over the plugin's", async () => {
        const CURSOR = "https://cursor.com/blog"
        const plugins: Record<string, SourcePlugin> = {
          scrape: {
            ...titled("Scrape"),
            canonical: (u) => (u.href === CURSOR ? CURSOR : null),
          },
        }
        expect(
          await fetchForAdd(CURSOR, { fetch: noFetch, plugins })
        ).toMatchObject({ kind: "feed", feed: { title: "Cursor blog" } })
      })
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
      ...(
        [
          [404, "not_found"],
          [410, "not_found"],
          [429, "unreachable"],
          [500, "unreachable"],
          [503, "unreachable"],
        ] as const
      ).map(
        ([status, code]) =>
          [
            `a list page answering ${status} → ${code}`,
            async () => {
              throw new SourceStatusError(status, new Headers())
            },
            code,
          ] as [string, SourcePlugin["fetchEntries"], string]
      ),
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

  describe("spellings of one plugin address reach one feed", () => {
    // A parameterised plugin like the trending one to come: http, www and a
    // trailing slash are spellings of one list, and `since` picks a list.
    const LIST = "https://lists.example/top"
    const post: IngestedEntry = {
      guid: "https://lists.example/one",
      url: "https://lists.example/one",
      title: "One",
      author: null,
      publishedAt: new Date(NOW.getTime() - HOUR),
      summary: null,
      contentHtml: "<p>One</p>",
    }
    const lists = (fetchEntries: SourcePlugin["fetchEntries"]) => ({
      lists: {
        id: "lists",
        canonical: (u: URL) => {
          if (u.hostname.replace(/^www\./, "") !== "lists.example") return null
          if (u.pathname.replace(/\/$/, "") !== "/top") return null
          const since = u.searchParams.get("since") ?? "daily"
          return since === "daily" ? LIST : `${LIST}?since=${since}`
        },
        fetchEntries,
      } satisfies SourcePlugin,
    })
    const counted = () => {
      const urls: string[] = []
      const plugins = lists(async (ctx) => {
        urls.push(ctx.url)
        return [post]
      })
      return { plugins, urls }
    }

    test("a second spelling subscribes to the stored feed without a fetch", async () => {
      const { plugins, urls } = counted()
      const first = await subscribe(
        "u1",
        { url: "http://www.lists.example/top/" },
        { fetch: noFetch, plugins, now: NOW }
      )
      const second = await subscribe(
        "u2",
        { url: `${LIST}?since=daily#x` },
        { fetch: noFetch, plugins, now: NOW }
      )
      expect(first).toMatchObject({ ok: true, existed: false })
      expect(second).toMatchObject({ ok: true, existed: false })
      expect(urls).toEqual([LIST])
      const feeds = await db.feed.findMany()
      expect(feeds.map((feed) => feed.url)).toEqual([LIST])
      expect(
        await db.subscription.count({ where: { feedId: feeds[0].id } })
      ).toBe(2)
    })

    test("two spellings added at once share one feed", async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      let arrived = 0
      const plugins = lists(async () => {
        arrived++
        await gate
        return [post]
      })
      const first = subscribe(
        "u1",
        { url: `${LIST}/` },
        { fetch: noFetch, plugins, now: NOW }
      )
      const second = subscribe(
        "u2",
        { url: "http://lists.example/top" },
        { fetch: noFetch, plugins, now: NOW }
      )
      while (arrived < 2) await Bun.sleep(5)
      release()
      const results = await Promise.all([first, second])
      expect(results.map((r) => r.ok)).toEqual([true, true])
      const [a, b] = results as { feedId: string }[]
      expect(a.feedId).toBe(b.feedId)
      expect((await db.feed.findMany()).map((feed) => feed.url)).toEqual([LIST])
      expect(await db.subscription.count({ where: { feedId: a.feedId } })).toBe(
        2
      )
    })

    test("discovery offers canonical choices", async () => {
      const { plugins } = counted()
      const { fetch } = site({
        [PAGE]: {
          text: html(
            "http://www.lists.example/top/",
            `${LIST}?since=daily`,
            "https://lists.example/top?since=weekly",
            "/rss.xml"
          ),
        },
      })
      expect(
        await subscribe("u1", { url: PAGE }, { fetch, plugins, now: NOW })
      ).toEqual({
        ok: false,
        code: "multiple",
        choices: [
          LIST,
          `${LIST}?since=weekly`,
          "https://blog.example.com/rss.xml",
        ],
      })
      await nothingWritten()
    })

    test("one discovered spelling is stored canonical and reaches the stored feed", async () => {
      const { plugins, urls } = counted()
      const { fetch } = site({
        [PAGE]: { text: html("http://www.lists.example/top/") },
      })
      const first = await subscribe(
        "u1",
        { url: PAGE },
        { fetch, plugins, now: NOW }
      )
      expect(first).toMatchObject({ ok: true, existed: false })
      expect(urls).toEqual([LIST])
      const again = await subscribe(
        "u2",
        { url: PAGE },
        { fetch, plugins, now: NOW }
      )
      expect(again).toMatchObject({ ok: true, existed: false })
      expect(urls).toEqual([LIST])
      expect((await db.feed.findMany()).map((feed) => feed.url)).toEqual([LIST])
    })

    test("a built-in source still subscribes under its own URL", async () => {
      const { plugins } = counted()
      const CLAUDE = "https://claude.dev/rss.xml"
      const { fetch } = site({ [CLAUDE]: { text: rss([{ guid: "a" }]) } })
      expect(
        await subscribe(
          "u1",
          { source: "claude-code" },
          { fetch, plugins, now: NOW }
        )
      ).toMatchObject({ ok: true, existed: false })
      expect((await db.feed.findMany()).map((feed) => feed.url)).toEqual([
        CLAUDE,
      ])
    })
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
