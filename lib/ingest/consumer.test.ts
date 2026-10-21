import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import { db } from "@/test/db"

import { refreshFromMessage } from "./consumer"
import type { SafeFetch } from "./safe-fetch"

const NOW = new Date("2026-03-01T12:00:00Z")

const RSS =
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>` +
  `<item><guid isPermaLink="false">a</guid><title>A</title></item>` +
  `</channel></rss>`

let fetched = 0
const fetch: SafeFetch = async (url) => {
  fetched++
  return { status: 200, url, headers: new Headers(), text: RSS, kind: "xml" }
}

let errors: ReturnType<typeof spyOn>

beforeEach(() => {
  fetched = 0
  errors = spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => errors.mockRestore())

const feed = (lastFetchedAt: Date | null) =>
  db.feed.create({
    data: { id: "f1", url: "https://f1.example.com/feed.xml", lastFetchedAt },
  })

describe("refreshFromMessage", () => {
  test("refreshes the message's feed", async () => {
    await feed(null)
    expect(
      await refreshFromMessage({ feedId: "f1" }, { fetch, now: NOW })
    ).toEqual({
      outcome: "ok",
      stored: 1,
    })
  })

  test("skips a feed fetched under 2 minutes ago", async () => {
    await feed(new Date(NOW.getTime() - 119_000))
    expect(
      await refreshFromMessage({ feedId: "f1" }, { fetch, now: NOW })
    ).toEqual({
      outcome: "skipped",
    })
    expect(fetched).toBe(0)
  })

  test("refreshes a feed fetched 2 minutes ago", async () => {
    await feed(new Date(NOW.getTime() - 120_000))
    expect(
      (await refreshFromMessage({ feedId: "f1" }, { fetch, now: NOW }))?.outcome
    ).toBe("ok")
  })

  test("a missing feed is acknowledged", async () => {
    expect(
      await refreshFromMessage({ feedId: "nope" }, { fetch, now: NOW })
    ).toEqual({
      outcome: "missing",
    })
  })

  for (const message of [null, "f1", 42, {}, { feedId: 1 }, { feedId: null }]) {
    test(`malformed message ${JSON.stringify(message)} is logged, not thrown`, async () => {
      await feed(null)
      expect(
        await refreshFromMessage(message, { fetch, now: NOW })
      ).toBeUndefined()
      expect(errors).toHaveBeenCalled()
      expect(fetched).toBe(0)
    })
  }
})
