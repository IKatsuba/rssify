import { readFileSync } from "node:fs"

import { describe, expect, test } from "bun:test"

import type { SourcePlugin } from "@/sources/types"
import { db } from "@/test/db"

import { normaliseEntry } from "./parse"
import { refreshFeed } from "./refresh"
import { SafeFetchError, type SafeFetch } from "./safe-fetch"

const NOW = new Date("2026-10-22T12:00:00Z")
const HOUR = 3_600_000
const LIST = "https://cursor.com/blog"
const seed = () =>
  db.feed.create({
    data: { id: "plugin-tester", url: LIST, pluginId: "cursor-blog" },
  })
const row = () => db.feed.findUniqueOrThrow({ where: { id: "plugin-tester" } })
const registry = (fetchEntries: SourcePlugin["fetchEntries"]) => ({
  "cursor-blog": {
    id: "cursor-blog",
    canonical: (u: URL) => (u.href === LIST ? LIST : null),
    fetchEntries,
  },
})
const noFetch: SafeFetch = async () => {
  throw new Error("unexpected network request")
}

describe("plugin refresh tester acceptance", () => {
  test("registered plugin repeat delivery skips; later run fetches only the known list", async () => {
    await seed()
    const savedPost = readFileSync(
      "test/fixtures/cursor-blog/projects.html",
      "utf8"
    )
    const calls: string[] = []
    const signals: AbortSignal[] = []
    const fetch: SafeFetch = async (url, options) => {
      calls.push(url)
      signals.push(options!.deadline!)
      return {
        status: 200,
        url,
        headers: new Headers(),
        kind: "unknown",
        text:
          url === LIST
            ? '<a href="/blog/projects"><article></article></a>'
            : savedPost,
      }
    }
    expect(await refreshFeed("plugin-tester", { fetch, now: NOW })).toEqual({
      outcome: "ok",
      stored: 1,
    })
    expect(signals[0]).toBe(signals[1])
    const first = await row()
    expect(
      await refreshFeed("plugin-tester", {
        fetch,
        now: new Date(+NOW + 119999),
        skipIfFreshWithin: 120,
      })
    ).toEqual({ outcome: "skipped" })
    expect(await row()).toEqual(first)
    expect(calls).toHaveLength(2)
    expect(
      await refreshFeed("plugin-tester", {
        fetch,
        now: new Date(+NOW + 120000),
        skipIfFreshWithin: 120,
      })
    ).toEqual({ outcome: "ok", stored: 0 })
    expect(calls).toEqual([LIST, `${LIST}/projects`, LIST])
    expect(await db.entry.count()).toBe(1)
  })

  test.each([304, 404, 429, 503])(
    "registered list status %i follows failure scheduling",
    async (status) => {
      await seed()
      const fetch: SafeFetch = async (url) => ({
        status,
        url,
        headers: new Headers({ "retry-after": "999999" }),
        text: "",
        kind: "unknown",
      })
      expect(
        (await refreshFeed("plugin-tester", { fetch, now: NOW })).outcome
      ).toBe("failed")
      expect(await row()).toMatchObject({
        failureCount: 1,
        lastFetchedAt: NOW,
        lastSuccessAt: null,
        nextFetchAt: new Date(
          +NOW + ([429, 503].includes(status) ? 24 : 2) * HOUR
        ),
      })
      expect(await db.entry.count()).toBe(0)
    }
  )

  test("plugin storage takes newest 100, retains 500 and preserves original versions", async () => {
    await seed()
    await db.entry.createMany({
      data: Array.from({ length: 500 }, (_, i) => ({
        id: `old-${String(i).padStart(3, "0")}`,
        feedId: "plugin-tester",
        guid: `old-${i}`,
        title: "Original",
        sortAt: new Date(+NOW - HOUR),
      })),
    })
    const entries = Array.from({ length: 101 }, (_, i) =>
      normaliseEntry(
        {
          id: `new-${i}`,
          title: String(i),
          published: new Date(+NOW - i * 1000).toISOString(),
        },
        LIST
      )
    )
    entries.push(
      normaliseEntry(
        { id: "old-499", title: "Changed", published: NOW.toISOString() },
        LIST
      )
    )
    const plugins = registry(async () => entries)
    expect(
      await refreshFeed("plugin-tester", { fetch: noFetch, plugins, now: NOW })
    ).toEqual({ outcome: "ok", stored: 99 })
    expect(await db.entry.count()).toBe(500)
    expect(await db.entry.count({ where: { guid: "new-99" } })).toBe(0)
    expect(
      (await db.entry.findUniqueOrThrow({ where: { id: "old-499" } })).title
    ).toBe("Original")
    expect(await db.entry.findUnique({ where: { id: "old-000" } })).toBeNull()
  })

  test("real 40 second plugin deadline aborts the supplied fetch and records timeout", async () => {
    await seed()
    let signal: AbortSignal | undefined
    const fetch: SafeFetch = async (_url, options) => {
      signal = options!.deadline!
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true })
      )
      throw new SafeFetchError("unreachable", "injected source timeout")
    }
    const plugins = registry(async (ctx) => {
      await ctx.fetch(LIST, { deadline: ctx.deadline })
      return []
    })
    const started = performance.now()
    expect(
      await refreshFeed("plugin-tester", { fetch, plugins, now: NOW })
    ).toEqual({ outcome: "failed", error: "the site didn’t answer in time" })
    expect(performance.now() - started).toBeGreaterThanOrEqual(39500)
    expect(signal?.aborted).toBe(true)
    expect(await row()).toMatchObject({
      failureCount: 1,
      lastFetchedAt: NOW,
      lastSuccessAt: null,
      nextFetchAt: new Date(+NOW + 2 * HOUR),
    })
    expect(await db.entry.count()).toBe(0)
  }, 50000)
})
