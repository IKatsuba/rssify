import { beforeEach, describe, expect, test } from "bun:test"

import { db } from "@/test/db"

import { fanOut } from "./fan-out"
import { refreshFeed } from "./refresh"
import { SafeFetchError, type SafeFetch } from "./safe-fetch"

const MINUTE = 60_000

beforeEach(async () => {
  await db.user.create({
    data: { id: "tester", name: "Tester", email: "tester@example.com" },
  })
})

async function seed(count: number) {
  const now = Date.now()
  const feeds = Array.from({ length: count }, (_, index) => ({
    id: `tester-${index}`,
    url: `https://example.com/tester-${index}.xml`,
    nextFetchAt: new Date(now - (count - index) * MINUTE),
  }))
  await db.feed.createMany({ data: feeds })
  await db.subscription.createMany({
    data: feeds.map(({ id }) => ({ userId: "tester", feedId: id })),
  })
}

describe("fan-out additional acceptance", () => {
  test("takes the oldest 500, leaving the remaining due feed for the next run", async () => {
    await seed(501)
    const sent = new Set<string>()
    expect(
      await fanOut(async (id) => {
        sent.add(id)
      })
    ).toEqual({
      claimed: 500,
      sent: 500,
      failed: 0,
    })
    expect(sent.size).toBe(500)
    expect(sent.has("tester-500")).toBe(false)
    const rest: string[] = []
    expect(
      await fanOut(async (id) => {
        rest.push(id)
      })
    ).toEqual({
      claimed: 1,
      sent: 1,
      failed: 0,
    })
    expect(rest).toEqual(["tester-500"])
  })

  test("awaits every send in the first chunk before starting the next", async () => {
    await seed(51)
    let started = 0
    let active = 0
    let peak = 0
    let release!: () => void
    let ready!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const firstChunk = new Promise<void>((resolve) => {
      ready = resolve
    })
    const run = fanOut(async () => {
      started++
      active++
      peak = Math.max(peak, active)
      if (started === 50) ready()
      try {
        await gate
      } finally {
        active--
      }
    })
    try {
      await firstChunk
      expect(started).toBe(50)
      expect(active).toBe(50)
    } finally {
      release()
    }
    expect(await run).toEqual({ claimed: 51, sent: 51, failed: 0 })
    expect(peak).toBe(50)
    expect(active).toBe(0)
  })

  test("a claimed but unsent feed can be reclaimed after its lease expires", async () => {
    await seed(1)
    let calls = 0
    const result = await fanOut(
      async () => {
        calls++
      },
      {
        clock: (() => {
          let n = 0
          return () => (n++ === 0 ? 0 : 240_000)
        })(),
      }
    )
    expect(result).toEqual({ claimed: 1, sent: 0, failed: 0 })
    expect(calls).toBe(0)
    expect(
      await fanOut(async () => {
        calls++
      })
    ).toEqual({ claimed: 0, sent: 0, failed: 0 })
    await db.feed.update({
      where: { id: "tester-0" },
      data: { nextFetchAt: new Date(Date.now() - MINUTE) },
    })
    expect(
      await fanOut(async () => {
        calls++
      })
    ).toEqual({ claimed: 1, sent: 1, failed: 0 })
    expect(calls).toBe(1)
  })

  for (const status of [304, 404, 429, 500, "blocked", "malformed"] as const) {
    test(`claim then ${status} consumer outcome is recorded and duplicate delivery skips`, async () => {
      await seed(1)
      let fetched = 0
      const fetch: SafeFetch = async (url) => {
        fetched++
        if (status === "blocked")
          throw new SafeFetchError("blocked", "local address")
        return {
          status: status === "malformed" ? 200 : status,
          url,
          headers: new Headers(
            status === 429 ? { "retry-after": "10800" } : {}
          ),
          text: status === "malformed" ? "<html>not a feed</html>" : "",
          kind: "xml",
        }
      }
      const now = new Date()
      const outcomes: unknown[] = []
      expect(
        await fanOut(async (id) => {
          outcomes.push(
            await refreshFeed(id, { fetch, now, skipIfFreshWithin: 120 })
          )
        })
      ).toEqual({ claimed: 1, sent: 1, failed: 0 })
      expect(outcomes[0]).toMatchObject({
        outcome: status === 304 ? "not_modified" : "failed",
      })
      const row = await db.feed.findUniqueOrThrow({ where: { id: "tester-0" } })
      expect(row.lastFetchedAt).toEqual(now)
      expect(row.nextFetchAt).toEqual(
        new Date(
          now.getTime() +
            (status === 304 ? 60 : status === 429 ? 180 : 120) * MINUTE
        )
      )
      expect(row.failureCount).toBe(status === 304 ? 0 : 1)
      expect(
        await refreshFeed(row.id, { fetch, now, skipIfFreshWithin: 120 })
      ).toEqual({ outcome: "skipped" })
      expect(fetched).toBe(1)
    })
  }
})
