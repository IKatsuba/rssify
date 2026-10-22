import { readFileSync } from "node:fs"

import { beforeEach, describe, expect, test } from "bun:test"

import { db } from "@/test/db"

import { SafeFetchError, type SafeFetch } from "./ingest/safe-fetch"
import { subscribe, SUBSCRIPTION_LIMIT } from "./reader"

const NOW = new Date("2026-10-22T12:00:00Z")
const PAGE = "https://site.example/news/"
const FEED = "https://site.example/feed"
const saved = (name: string) =>
  readFileSync(`test/fixtures/feeds/${name}`, "utf8")
const fixture = JSON.parse(saved("handmade-content-text.feed.json"))
const body = JSON.stringify({ ...fixture, items: [fixture.items[0]] })
const page = (href = "/feed") =>
  `<head><link rel="alternate" type="application/feed+json" href="${href}"></head>`
const response = (url: string, text = body) => ({
  status: 200,
  url,
  text,
  headers: new Headers(),
  kind: "json" as const,
})
const noFetch: SafeFetch = async () => {
  throw new Error("must not fetch")
}

async function assertEmpty() {
  expect(await db.feed.count()).toBe(0)
  expect(await db.entry.count()).toBe(0)
  expect(await db.subscription.count()).toBe(0)
  expect(await db.readMark.count()).toBe(0)
}

async function fill(count: number) {
  await db.feed.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      id: `stored-${i}`,
      url: `https://stored.example/${i}`,
    })),
  })
  await db.subscription.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      userId: "tester",
      feedId: `stored-${i}`,
    })),
  })
}

// Both requests must reach the fake source before either can store.
function twoArrivals() {
  let arrivals = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  return async () => {
    if (++arrivals === 2) release()
    await gate
  }
}

beforeEach(async () => {
  await db.user.create({
    data: { id: "tester", name: "Tester", email: "tester@example.invalid" },
  })
})

describe("subscribe tester acceptance edges", () => {
  for (const status of [304, 404, 429, 500, 503]) {
    test(`discovered source answers ${status}: no partial writes`, async () => {
      const calls: string[] = []
      const fetch: SafeFetch = async (url) => {
        calls.push(url)
        if (url === PAGE) return response(url, page())
        expect(url).toBe(FEED)
        return {
          ...response(url),
          status,
          headers: new Headers({ "retry-after": "86400" }),
        }
      }
      expect(await subscribe("tester", { url: PAGE }, { fetch })).toEqual({
        ok: false,
        code: status === 404 ? "not_found" : "unreachable",
      })
      expect(calls).toEqual([PAGE, FEED])
      await assertEmpty()
    })
  }

  for (const code of ["blocked", "too_large"] as const) {
    test(`discovered source throws ${code}: no partial writes`, async () => {
      const fetch: SafeFetch = async (url) => {
        if (url === PAGE) return response(url, page())
        throw new SafeFetchError(code, "fake source rejection")
      }
      expect(await subscribe("tester", { url: PAGE }, { fetch })).toEqual({
        ok: false,
        code,
      })
      await assertEmpty()
    })
  }

  test("an actual add deadline aborts a fake stalled source without writes", async () => {
    const fetch: SafeFetch = async (_url, options) => {
      const signal = options?.deadline
      expect(signal).toBeInstanceOf(AbortSignal)
      return new Promise((_resolve, reject) => {
        signal!.addEventListener(
          "abort",
          () => reject(new SafeFetchError("unreachable", "fake timeout")),
          { once: true }
        )
      })
    }
    expect(await subscribe("tester", { url: FEED }, { fetch })).toEqual({
      ok: false,
      code: "unreachable",
    })
    await assertEmpty()
  }, 20_000)

  test("saved truncated Atom rejects without writes; truncated RSS keeps partial entries", async () => {
    expect(
      await subscribe(
        "tester",
        { url: FEED },
        {
          fetch: async (url) =>
            response(url, saved("handmade-truncated.atom.xml")),
        }
      )
    ).toEqual({ ok: false, code: "not_found" })
    await assertEmpty()
    expect(
      await subscribe(
        "tester",
        { url: FEED },
        {
          fetch: async (url) =>
            response(url, saved("handmade-truncated.rss.xml")),
        }
      )
    ).toMatchObject({ ok: true })
    expect(await db.entry.count()).toBe(8)
  })

  test("an empty saved feed succeeds and repeated GUIDs keep their first version", async () => {
    const empty = JSON.stringify({ ...fixture, items: [] })
    expect(
      await subscribe(
        "tester",
        { url: FEED },
        {
          fetch: async (url) => response(url, empty),
        }
      )
    ).toMatchObject({ ok: true })
    expect(await db.entry.count()).toBe(0)
    const repeated = JSON.stringify({
      ...fixture,
      items: [fixture.items[0], { ...fixture.items[0], title: "Changed" }],
    })
    expect(
      await subscribe(
        "tester",
        { url: `${FEED}/other` },
        {
          fetch: async (url) => response(url, repeated),
        }
      )
    ).toMatchObject({ ok: true })
    expect(await db.entry.count()).toBe(1)
    expect((await db.entry.findFirstOrThrow()).title).toBe("Use <tag> & more")
  })

  test("redirected page plus base resolves discovery; redirected feed keeps discovered input", async () => {
    const discovered = "https://cdn.example/feeds/json"
    const calls: string[] = []
    const fetch: SafeFetch = async (url) => {
      calls.push(url)
      if (url === PAGE) {
        return response(
          "https://cdn.example/blog/page",
          `<head><base href="../feeds/">${page("json#one")}${page("json#two")}</head>`
        )
      }
      expect(url).toBe(discovered)
      return response("https://storage.example/moved", body)
    }
    expect(await subscribe("tester", { url: PAGE }, { fetch })).toMatchObject({
      ok: true,
    })
    expect(calls).toEqual([PAGE, discovered])
    expect((await db.feed.findFirstOrThrow()).url).toBe(discovered)
  })

  test("rechecks a discovered feed created during the page fetch without fetching it", async () => {
    let calls = 0
    const fetch: SafeFetch = async (url) => {
      calls++
      expect(url).toBe(PAGE)
      await db.feed.create({ data: { url: FEED, title: "Already stored" } })
      return response(url, page())
    }
    expect(await subscribe("tester", { url: PAGE }, { fetch })).toMatchObject({
      ok: true,
      existed: false,
    })
    expect(calls).toBe(1)
    expect((await db.feed.findFirstOrThrow()).title).toBe("Already stored")
    expect(await db.entry.count()).toBe(0)
  })

  test("existing built-in is reused unchanged, even when gone", async () => {
    const feed = await db.feed.create({
      data: {
        url: "https://claude.dev/rss.xml",
        status: "gone",
        failureCount: 7,
        lastError: "old failure",
        lastFetchedAt: NOW,
        nextFetchAt: null,
      },
    })
    for (const existed of [false, true]) {
      expect(
        await subscribe("tester", { source: "claude-code" }, { fetch: noFetch })
      ).toEqual({ ok: true, feedId: feed.id, existed })
    }
    expect(await db.feed.findUniqueOrThrow({ where: { id: feed.id } })).toEqual(
      feed
    )
    expect(await db.subscription.count()).toBe(1)
  })

  test("same-user simultaneous adds are idempotent and preserve one fetched version", async () => {
    const arrive = twoArrivals()
    const fetch: SafeFetch = async (url) => {
      await arrive()
      return response(url)
    }
    const results = await Promise.all([
      subscribe("tester", { url: FEED }, { fetch }),
      subscribe("tester", { url: FEED }, { fetch }),
    ])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(results.map((result) => result.ok && result.existed).sort()).toEqual(
      [false, true]
    )
    expect(await db.feed.count()).toBe(1)
    expect(await db.entry.count()).toBe(1)
    expect(await db.subscription.count()).toBe(1)
  })

  test("simultaneous new URLs at 499 allow one subscription and no orphan loser", async () => {
    await fill(SUBSCRIPTION_LIMIT - 1)
    const arrive = twoArrivals()
    const fetch: SafeFetch = async (url) => {
      await arrive()
      return response(url)
    }
    const results = await Promise.all([
      subscribe("tester", { url: FEED }, { fetch }),
      subscribe("tester", { url: `${FEED}/other` }, { fetch }),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, code: "limit" },
    ])
    expect(await db.subscription.count()).toBe(SUBSCRIPTION_LIMIT)
    expect(await db.feed.count()).toBe(SUBSCRIPTION_LIMIT)
    expect(await db.entry.count()).toBe(1)
  })
})
