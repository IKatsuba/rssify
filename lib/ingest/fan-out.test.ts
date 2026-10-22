import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import { db } from "@/test/db"

import { fanOut, tickOf } from "./fan-out"
import { refreshFeed } from "./refresh"
import type { SafeFetch } from "./safe-fetch"

const MIN = 60_000
const LEASE = 30 * MIN

const RSS =
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>` +
  `<link>https://blog.example.com/</link>` +
  `<item><guid isPermaLink="false">a</guid><title>A</title></item>` +
  `</channel></rss>`

const ok: SafeFetch = async (url) => ({
  status: 200,
  url,
  headers: new Headers(),
  text: RSS,
  kind: "xml",
})

const ago = (ms: number) => new Date(Date.now() - ms)

async function feed(
  id: string,
  data: Record<string, unknown> = {},
  subscribed = true
) {
  await db.feed.create({
    data: {
      id,
      url: `https://${id}.example.com/feed.xml`,
      nextFetchAt: ago(MIN),
      ...data,
      ...(subscribed && { subscriptions: { create: { userId: "u1" } } }),
    },
  })
}

const row = (id: string) => db.feed.findUniqueOrThrow({ where: { id } })

function collect() {
  const ids: string[] = []
  return {
    ids,
    enqueue: async (id: string) => {
      ids.push(id)
    },
  }
}

let errors: ReturnType<typeof spyOn>

beforeEach(async () => {
  await db.user.create({
    data: { id: "u1", name: "u1", email: "u1@example.com" },
  })
  errors = spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => errors.mockRestore())

describe("tickOf", () => {
  test("rounds down to the 15-minute slot", () => {
    expect(tickOf(new Date("2026-03-01T12:29:59.999Z"))).toBe(
      "2026-03-01T12:15:00.000Z"
    )
    expect(tickOf(new Date("2026-03-01T12:30:00.000Z"))).toBe(
      "2026-03-01T12:30:00.000Z"
    )
  })
})

describe("fanOut", () => {
  test("claims only due, subscribed, non-gone feeds", async () => {
    await feed("due")
    await feed("future", { nextFetchAt: new Date(Date.now() + MIN) })
    await feed("gone", { nextFetchAt: null, status: "gone" })
    await feed("orphan", {}, false)
    const { ids, enqueue } = collect()
    expect(await fanOut(enqueue)).toEqual({ claimed: 1, sent: 1, failed: 0 })
    expect(ids).toEqual(["due"])
    expect((await row("future")).nextFetchAt!.getTime()).toBeGreaterThan(
      Date.now()
    )
    expect((await row("gone")).nextFetchAt).toBeNull()
    expect((await row("orphan")).nextFetchAt!.getTime()).toBeLessThan(
      Date.now()
    )
  })

  test("a claimed feed is leased for 30 minutes", async () => {
    await feed("due")
    const before = Date.now()
    await fanOut(collect().enqueue)
    const next = (await row("due")).nextFetchAt!.getTime()
    expect(next).toBeGreaterThanOrEqual(before + LEASE - 5_000)
    expect(next).toBeLessThanOrEqual(Date.now() + LEASE + 5_000)
  })

  test("a second run right after claims nothing", async () => {
    await feed("due")
    await fanOut(collect().enqueue)
    expect(await fanOut(collect().enqueue)).toEqual({
      claimed: 0,
      sent: 0,
      failed: 0,
    })
  })

  test("two concurrent claims split the set with no overlap", async () => {
    const all = Array.from({ length: 40 }, (_, i) => `f${i}`)
    for (const id of all) await feed(id)
    const a = collect()
    const b = collect()
    await Promise.all([fanOut(a.enqueue), fanOut(b.enqueue)])
    expect(a.ids.filter((id) => b.ids.includes(id))).toEqual([])
    expect([...a.ids, ...b.ids].sort()).toEqual([...all].sort())
  })

  test("a failed send is logged, counted and left to the lease", async () => {
    await feed("bad")
    await feed("good", { nextFetchAt: ago(2 * MIN) })
    const result = await fanOut(async (id) => {
      if (id === "bad") throw new Error("queue down")
    })
    expect(result).toEqual({ claimed: 2, sent: 1, failed: 1 })
    expect(errors).toHaveBeenCalledWith(
      "feed-refresh send failed for bad:",
      "queue down"
    )
    expect((await row("bad")).nextFetchAt!.getTime()).toBeGreaterThan(
      Date.now() + LEASE - 5 * MIN
    )
  })

  test("stops starting chunks once 240 s have passed", async () => {
    for (let i = 0; i < 120; i++) await feed(`f${i}`)
    let time = 0
    const { ids } = collect()
    const result = await fanOut(
      async (id) => {
        ids.push(id)
        time = 240_000
      },
      { clock: () => time }
    )
    expect(result).toEqual({ claimed: 120, sent: 50, failed: 0 })
    expect(ids).toHaveLength(50)
    // The unsent rest stay leased, not due.
    expect(
      await db.feed.count({ where: { nextFetchAt: { lte: new Date() } } })
    ).toBe(0)
  })
})

describe("fan-out → consumer", () => {
  const consume = (id: string) =>
    refreshFeed(id, { skipIfFreshWithin: 120, fetch: ok })

  test("the consumer refreshes a claimed feed; a duplicate is skipped", async () => {
    await feed("due")
    const outcomes: unknown[] = []
    await fanOut(async (id) => outcomes.push(await consume(id)))
    expect(outcomes).toEqual([{ outcome: "ok", stored: 1 }])
    const after = await row("due")
    expect(after.lastFetchedAt).not.toBeNull()
    expect(await db.entry.count({ where: { feedId: "due" } })).toBe(1)
    expect(await consume("due")).toEqual({ outcome: "skipped" })
  })

  test("a redelivery after a database error refreshes", async () => {
    await feed("due", { lastFetchedAt: ago(60 * MIN) })
    const { ids, enqueue } = collect()
    await fanOut(enqueue)
    expect(ids).toEqual(["due"])
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fan_out_test_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'fan-out test failure'; END $$ LANGUAGE plpgsql`)
    await db.$executeRawUnsafe(`
      CREATE TRIGGER fan_out_test_fail BEFORE UPDATE ON "Feed"
      FOR EACH ROW EXECUTE FUNCTION fan_out_test_fail()`)
    try {
      await expect(consume("due")).rejects.toThrow()
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER fan_out_test_fail ON "Feed"`)
      await db.$executeRawUnsafe(`DROP FUNCTION fan_out_test_fail()`)
    }
    expect(await consume("due")).toEqual({ outcome: "ok", stored: 1 })
  })
})
