import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { db } from "@/test/db"

import { refreshFeed } from "./refresh"
import { SafeFetchError, type SafeFetch } from "./safe-fetch"

const NOW = new Date("2026-10-22T12:00:00Z")
const HOUR = 3_600_000
const URL = "https://example.test/feed.json"
const at = (offset: number) => new Date(NOW.getTime() + offset)
const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../test/fixtures/feeds", name), "utf8")
const json = (items: unknown[]) =>
  JSON.stringify({ version: "https://jsonfeed.org/version/1.1", items })
const response = (status: number, text = "", headers = {}) => ({
  status,
  text,
  headers: new Headers(headers),
  url: URL,
  kind: "json" as const,
})
const answer =
  (status: number, text = "", headers = {}): SafeFetch =>
  async () =>
    response(status, text, headers)
const seed = () => db.feed.create({ data: { id: "tester-feed", url: URL } })
const row = () => db.feed.findUniqueOrThrow({ where: { id: "tester-feed" } })

// These exercise only the refresh seam and local throwaway Postgres.
// Every fetch is injected; no test calls an HTTP transport.
describe("refreshFeed independent acceptance coverage", () => {
  test("duplicate delivery skips without mutation; exactly 120 seconds refreshes", async () => {
    await seed()
    let calls = 0
    const fetch: SafeFetch = async () => {
      calls++
      return response(200, json([{ id: "one", title: "Original" }]))
    }
    await refreshFeed("tester-feed", { fetch, now: NOW })
    const before = await row()
    expect(
      await refreshFeed("tester-feed", {
        fetch,
        now: at(119_999),
        skipIfFreshWithin: 120,
      })
    ).toEqual({ outcome: "skipped" })
    expect(await row()).toEqual(before)
    expect(calls).toBe(1)
    expect(
      await refreshFeed("tester-feed", {
        fetch,
        now: at(120_000),
        skipIfFreshWithin: 120,
      })
    ).toEqual({ outcome: "ok", stored: 0 })
    expect(calls).toBe(2)
    expect(await db.entry.count()).toBe(1)
  })

  test("empty feed succeeds, clears absent validators and preserves existing entries", async () => {
    await seed()
    await db.feed.update({
      where: { id: "tester-feed" },
      data: {
        etag: "old",
        lastModified: "old",
        failureCount: 4,
        status: "failing",
      },
    })
    await db.entry.create({
      data: {
        feedId: "tester-feed",
        guid: "existing",
        title: "Kept",
        sortAt: NOW,
      },
    })
    expect(
      await refreshFeed("tester-feed", {
        fetch: answer(200, json([])),
        now: NOW,
      })
    ).toEqual({ outcome: "ok", stored: 0 })
    expect(await row()).toMatchObject({
      status: "ok",
      failureCount: 0,
      lastError: null,
      etag: null,
      lastModified: null,
      lastSuccessAt: NOW,
      nextFetchAt: at(HOUR),
    })
    expect(await db.entry.count()).toBe(1)
  })

  test("stores the eight partial items returned from the saved truncated RSS", async () => {
    await seed()
    expect(
      await refreshFeed("tester-feed", {
        fetch: answer(200, fixture("handmade-truncated.rss.xml")),
        now: NOW,
      })
    ).toEqual({ outcome: "ok", stored: 8 })
    expect(await db.entry.count()).toBe(8)
    expect((await row()).lastSuccessAt).toEqual(NOW)
  })

  test("records a parse failure for the saved truncated Atom", async () => {
    await seed()
    expect(
      await refreshFeed("tester-feed", {
        fetch: answer(200, fixture("handmade-truncated.atom.xml")),
        now: NOW,
      })
    ).toEqual({ outcome: "failed", error: "the response wasn’t a feed" })
    expect(await db.entry.count()).toBe(0)
    expect(await row()).toMatchObject({
      lastSuccessAt: null,
      lastFetchedAt: NOW,
      failureCount: 1,
    })
  })

  test("malformed JSON preserves metadata, validators and existing entries", async () => {
    await seed()
    await refreshFeed("tester-feed", {
      fetch: answer(200, json([{ id: "old", title: "Kept" }]), {
        etag: "kept",
      }),
      now: NOW,
    })
    const before = await row()
    expect(
      await refreshFeed("tester-feed", {
        fetch: answer(
          200,
          '{"version":"https://jsonfeed.org/version/1.1","items":['
        ),
        now: at(HOUR),
      })
    ).toEqual({ outcome: "failed", error: "the response wasn’t a feed" })
    expect(await row()).toMatchObject({
      title: before.title,
      siteUrl: before.siteUrl,
      etag: "kept",
      lastSuccessAt: NOW,
      lastFetchedAt: at(HOUR),
      nextFetchAt: at(3 * HOUR),
    })
    expect(await db.entry.count()).toBe(1)
  })

  test.each([429, 503])(
    "%i without Retry-After uses ordinary backoff",
    async (status) => {
      await seed()
      await refreshFeed("tester-feed", { fetch: answer(status), now: NOW })
      expect(await row()).toMatchObject({
        failureCount: 1,
        nextFetchAt: at(2 * HOUR),
      })
    }
  )

  test("304 ignores a hostile body and preserves entries, replacing both validators", async () => {
    await seed()
    const fetch = answer(304, "<script>must not parse</script>", {
      etag: '"new"',
      "last-modified": NOW.toUTCString(),
    })
    expect(await refreshFeed("tester-feed", { fetch, now: NOW })).toEqual({
      outcome: "not_modified",
    })
    expect(await row()).toMatchObject({
      etag: '"new"',
      lastModified: NOW.toUTCString(),
      status: "ok",
    })
    expect(await db.entry.count()).toBe(0)
  })

  test("mixed future and undated entries share the cutoff in document order", async () => {
    await seed()
    const items = Array.from({ length: 101 }, (_, i) => ({
      id: String(i),
      title: String(i),
      ...(i % 2 ? { date_published: at((i + 1) * HOUR).toISOString() } : {}),
    }))
    expect(
      await refreshFeed("tester-feed", {
        fetch: answer(200, json(items)),
        now: NOW,
      })
    ).toEqual({ outcome: "ok", stored: 100 })
    expect(await db.entry.count({ where: { guid: "100" } })).toBe(0)
    expect(await db.entry.count({ where: { sortAt: NOW } })).toBe(100)
  })

  test("concurrent deliveries both fetch but store a single copy of each guid", async () => {
    await seed()
    let arrivals = 0
    let release!: () => void
    const bothFetching = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetch: SafeFetch = async () => {
      if (++arrivals === 2) release()
      await bothFetching
      return response(
        200,
        json([
          { id: "same", title: "First" },
          { id: "same", title: "Repeat" },
        ])
      )
    }
    const results = await Promise.all([
      refreshFeed("tester-feed", { fetch, now: NOW, skipIfFreshWithin: 120 }),
      refreshFeed("tester-feed", { fetch, now: NOW, skipIfFreshWithin: 120 }),
    ])
    expect(results.every((result) => result.outcome === "ok")).toBe(true)
    expect(arrivals).toBe(2)
    expect(await db.entry.count()).toBe(1)
    expect((await db.entry.findFirstOrThrow()).title).toBe("First")
    expect((await row()).status).toBe("ok")
  })

  test("retention tie-breaks by id and cascades only pruned read marks", async () => {
    await seed()
    await db.user.create({
      data: { id: "tester-user", name: "Test", email: "tester@example.test" },
    })
    await db.entry.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        id: `entry-${String(i).padStart(3, "0")}`,
        feedId: "tester-feed",
        guid: String(i),
        title: "Equal time",
        sortAt: NOW,
      })),
    })
    await db.readMark.createMany({
      data: ["entry-000", "entry-500"].map((entryId) => ({
        userId: "tester-user",
        entryId,
      })),
    })
    await refreshFeed("tester-feed", { fetch: answer(200, json([])), now: NOW })
    expect(await db.entry.count()).toBe(500)
    expect(await db.entry.findUnique({ where: { id: "entry-000" } })).toBeNull()
    expect((await db.readMark.findMany()).map((mark) => mark.entryId)).toEqual([
      "entry-500",
    ])
  })

  test("a feed-update DB error rolls back pruning and its cascaded read marks", async () => {
    await seed()
    await db.user.create({
      data: { id: "tester-user", name: "Test", email: "tester@example.test" },
    })
    await db.entry.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        id: `entry-${String(i).padStart(3, "0")}`,
        feedId: "tester-feed",
        guid: String(i),
        title: "Equal time",
        sortAt: NOW,
      })),
    })
    await db.readMark.create({
      data: { userId: "tester-user", entryId: "entry-000" },
    })
    await db.$executeRawUnsafe(
      `CREATE FUNCTION tester_refresh_reject() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'tester rollback'; END $$ LANGUAGE plpgsql`
    )
    await db.$executeRawUnsafe(
      `CREATE TRIGGER tester_refresh_reject BEFORE UPDATE ON "Feed" FOR EACH ROW EXECUTE FUNCTION tester_refresh_reject()`
    )
    try {
      await expect(
        refreshFeed("tester-feed", {
          fetch: answer(200, json([{ id: "new" }])),
          now: NOW,
        })
      ).rejects.toThrow()
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER tester_refresh_reject ON "Feed"`)
      await db.$executeRawUnsafe(`DROP FUNCTION tester_refresh_reject()`)
    }
    expect(await db.entry.count()).toBe(501)
    expect(await db.entry.count({ where: { guid: "new" } })).toBe(0)
    expect(await db.readMark.count()).toBe(1)
    expect((await row()).lastFetchedAt).toBeNull()
  })

  test("the real refresh deadline maps an aborted fake source to the timeout sentence", async () => {
    await seed()
    const fetch: SafeFetch = async (_url, options) => {
      const signal = options!.deadline!
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener("abort", () => resolve(), { once: true })
      })
      throw new SafeFetchError("unreachable", "fake source aborted")
    }
    expect(await refreshFeed("tester-feed", { fetch, now: NOW })).toEqual({
      outcome: "failed",
      error: "the site didn’t answer in time",
    })
    expect(await row()).toMatchObject({
      lastError: "the site didn’t answer in time",
      nextFetchAt: at(2 * HOUR),
      lastFetchedAt: NOW,
    })
  }, 20_000)
})
