import { describe, expect, test } from "bun:test"

import { db } from "@/test/db"

import { refreshFromMessage } from "./consumer"
import { SafeFetchError, type SafeFetch } from "./safe-fetch"

const NOW = new Date("2026-03-01T12:00:00Z")
const fixture = await Bun.file(
  "test/fixtures/feeds/jsonfeed-org.feed.json"
).text()

async function seed() {
  await db.feed.create({
    data: {
      id: "consumer-tester",
      url: "https://example.com/original.json",
      nextFetchAt: new Date(NOW.getTime() + 30 * 60_000),
      lastFetchedAt: new Date(NOW.getTime() - 60 * 60_000),
    },
  })
}

const row = () =>
  db.feed.findUniqueOrThrow({ where: { id: "consumer-tester" } })

function fetcher(
  status = 200,
  text = fixture,
  headers = new Headers()
): SafeFetch {
  return async () => ({
    status,
    text,
    headers,
    url: "https://example.com/redirected.json",
    kind: "json",
  })
}

describe("consumer additional acceptance", () => {
  test("redelivering a leased feed stores a synthetic fixture only once and retains the polling URL", async () => {
    await seed()
    let calls = 0
    const fetch: SafeFetch = async (...args) => {
      calls++
      return fetcher()(...args)
    }
    expect(
      await refreshFromMessage(
        { feedId: "consumer-tester" },
        { fetch, now: NOW }
      )
    ).toMatchObject({ outcome: "ok" })
    const entries = await db.entry.findMany({
      where: { feedId: "consumer-tester" },
    })
    expect(entries.length).toBeGreaterThan(0)
    expect(
      await refreshFromMessage(
        { feedId: "consumer-tester" },
        { fetch, now: NOW }
      )
    ).toEqual({ outcome: "skipped" })
    expect(calls).toBe(1)
    expect(await db.entry.count()).toBe(entries.length)
    expect((await row()).url).toBe("https://example.com/original.json")
  })

  for (const status of [
    304,
    404,
    429,
    500,
    "too_large",
    "unreachable",
    "malformed",
    "empty",
  ] as const) {
    test(`${status} is acknowledged with polling state; duplicate does no fetch`, async () => {
      await seed()
      let calls = 0
      const fetch: SafeFetch = async (...args) => {
        calls++
        if (status === "too_large" || status === "unreachable")
          throw new SafeFetchError(status, "fixture failure")
        return fetcher(
          typeof status === "number" ? status : 200,
          status === "malformed"
            ? "not a feed"
            : status === "empty"
              ? JSON.stringify({
                  version: "https://jsonfeed.org/version/1.1",
                  title: "Empty",
                  items: [],
                })
              : "",
          new Headers(status === 429 ? { "retry-after": "10800" } : {})
        )(...args)
      }
      const outcome =
        status === 304 ? "not_modified" : status === "empty" ? "ok" : "failed"
      expect(
        await refreshFromMessage(
          { feedId: "consumer-tester" },
          { fetch, now: NOW }
        )
      ).toMatchObject({ outcome })
      const after = await row()
      expect(after.lastFetchedAt).toEqual(NOW)
      expect(after.failureCount).toBe(outcome === "failed" ? 1 : 0)
      expect(after.nextFetchAt).toEqual(
        new Date(
          NOW.getTime() +
            (status === 429 ? 180 : outcome === "failed" ? 120 : 60) * 60_000
        )
      )
      expect(
        await refreshFromMessage(
          { feedId: "consumer-tester" },
          { fetch, now: NOW }
        )
      ).toEqual({ outcome: "skipped" })
      expect(calls).toBe(1)
    })
  }

  test("DB write failure throws and preserves lastFetchedAt so redelivery refreshes", async () => {
    await seed()
    const before = await row()
    await db.$executeRawUnsafe(
      `CREATE FUNCTION consumer_tester_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'tester write failure'; END $$ LANGUAGE plpgsql`
    )
    await db.$executeRawUnsafe(
      `CREATE TRIGGER consumer_tester_fail BEFORE UPDATE ON "Feed" FOR EACH ROW EXECUTE FUNCTION consumer_tester_fail()`
    )
    try {
      await expect(
        refreshFromMessage(
          { feedId: before.id },
          { fetch: fetcher(), now: NOW }
        )
      ).rejects.toThrow()
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER consumer_tester_fail ON "Feed"`)
      await db.$executeRawUnsafe(`DROP FUNCTION consumer_tester_fail()`)
    }
    expect((await row()).lastFetchedAt).toEqual(before.lastFetchedAt)
    expect(await db.entry.count()).toBe(0)
    expect(
      await refreshFromMessage(
        { feedId: before.id },
        { fetch: fetcher(), now: NOW }
      )
    ).toMatchObject({ outcome: "ok" })
    expect((await row()).lastFetchedAt).toEqual(NOW)
  })
})
