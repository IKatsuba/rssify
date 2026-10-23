import { readFileSync } from "node:fs"

import { describe, expect, test } from "bun:test"

import { subscribe } from "@/lib/reader"
import { db } from "@/test/db"

import { fetchForAdd } from "./add"
import { refreshFeed } from "./refresh"
import { SafeFetchError, type SafeFetch } from "./safe-fetch"

const URL = "https://github.com/trending/javascript?since=monthly"
const NOW = new Date("2026-10-22T12:00:00Z")
const HOUR = 3_600_000
const fixture = (name: string) =>
  readFileSync(`test/fixtures/github-trending/${name}.html`, "utf8")

function page(text: string, status = 200, retryAfter = "86400"): SafeFetch {
  return async (url) => ({
    url,
    text,
    status,
    headers: new Headers({ "retry-after": retryAfter }),
    kind: "unknown",
  })
}

async function feed() {
  return db.feed.create({
    data: {
      url: URL,
      pluginId: "github-trending",
      title: "GitHub trending · javascript · this month",
    },
  })
}

describe("github-trending independent integration coverage", () => {
  test("reappearing repos keep their first version across two refreshes", async () => {
    await db.user.create({
      data: {
        id: "trending-reader",
        name: "Reader",
        email: "trending@example.test",
      },
    })
    const first = fixture("javascript-monthly")
    const result = await subscribe(
      "trending-reader",
      { url: URL },
      { fetch: page(first), now: NOW }
    )
    expect(result.ok).toBe(true)
    const stored = await db.feed.findUniqueOrThrow({ where: { url: URL } })
    const original = await db.entry.findMany({
      where: { feedId: stored.id },
      orderBy: { id: "asc" },
    })
    expect(original).toHaveLength(17)
    // Both casing and stats change, but the repository identity does not.
    const changed = first
      .replaceAll("/harbour-lab/TIDE", "/HARBOUR-LAB/tide")
      .replaceAll("41,207", "99,999")
    for (const offset of [HOUR, 2 * HOUR]) {
      expect(
        await refreshFeed(stored.id, {
          fetch: page(changed),
          now: new Date(NOW.getTime() + offset),
        })
      ).toEqual({ outcome: "ok", stored: 0 })
    }
    expect(
      await db.entry.findMany({
        where: { feedId: stored.id },
        orderBy: { id: "asc" },
      })
    ).toEqual(original)
    expect(
      await db.feed.findUniqueOrThrow({ where: { id: stored.id } })
    ).toMatchObject({
      title: stored.title,
      siteUrl: URL,
      failureCount: 0,
    })
  })

  test("a verified empty page is not_found at add and clears failures on refresh", async () => {
    const fetch = page(fixture("blankslate"))
    expect(await fetchForAdd(URL, { fetch })).toEqual({
      kind: "error",
      code: "not_found",
    })
    const stored = await feed()
    await db.feed.update({
      where: { id: stored.id },
      data: { failureCount: 3, status: "failing", lastError: "old failure" },
    })
    expect(await refreshFeed(stored.id, { fetch, now: NOW })).toEqual({
      outcome: "ok",
      stored: 0,
    })
    expect(
      await db.feed.findUniqueOrThrow({ where: { id: stored.id } })
    ).toMatchObject({
      failureCount: 0,
      status: "ok",
      lastError: null,
      nextFetchAt: new Date(NOW.getTime() + HOUR),
    })
  })

  test("malformed rows fail three times while keeping existing entries", async () => {
    const stored = await feed()
    await refreshFeed(stored.id, {
      fetch: page(fixture("javascript-monthly")),
      now: NOW,
    })
    const fetch = page(
      '<article class="Box-row"><h2>Missing repo link</h2></article>'
    )
    expect(await fetchForAdd(URL, { fetch })).toEqual({
      kind: "error",
      code: "not_found",
    })
    for (let i = 1; i <= 3; i++) {
      expect(await refreshFeed(stored.id, { fetch, now: NOW })).toEqual({
        outcome: "failed",
        error: "the page layout changed",
      })
      expect(
        await db.feed.findUniqueOrThrow({ where: { id: stored.id } })
      ).toMatchObject({ failureCount: i })
    }
    expect(
      await db.feed.findUniqueOrThrow({ where: { id: stored.id } })
    ).toMatchObject({ status: "failing" })
    expect(await db.entry.count({ where: { feedId: stored.id } })).toBe(17)
  })

  for (const status of [304, 403, 404, 429, 500, 503]) {
    test(`status ${status} maps at add and applies the plugin refresh backoff`, async () => {
      const fetch = page("", status)
      expect(await fetchForAdd(URL, { fetch })).toEqual({
        kind: "error",
        code: status === 404 ? "not_found" : "unreachable",
      })
      const stored = await feed()
      expect(await refreshFeed(stored.id, { fetch, now: NOW })).toMatchObject({
        outcome: "failed",
      })
      expect(
        await db.feed.findUniqueOrThrow({ where: { id: stored.id } })
      ).toMatchObject({
        failureCount: 1,
        nextFetchAt: new Date(
          NOW.getTime() + ([429, 503].includes(status) ? 24 : 2) * HOUR
        ),
      })
      expect(await db.entry.count()).toBe(0)
    })
  }

  for (const code of ["too_large", "unreachable"] as const) {
    test(`a guarded fetch ${code} failure is preserved without storing entries`, async () => {
      const fetch: SafeFetch = async () => {
        throw new SafeFetchError(code, "fixture failure")
      }
      expect(await fetchForAdd(URL, { fetch })).toEqual({ kind: "error", code })
      const stored = await feed()
      expect(await refreshFeed(stored.id, { fetch, now: NOW })).toEqual({
        outcome: "failed",
        error:
          code === "too_large"
            ? "the feed is over 10 MB"
            : "the address couldn’t be found",
      })
      expect(await db.entry.count()).toBe(0)
    })
  }
})
