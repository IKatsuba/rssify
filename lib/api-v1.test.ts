import { beforeEach, describe, expect, test } from "bun:test"
import { serializeSignedCookie } from "better-call"

import * as entriesRoute from "@/app/api/v1/entries/route"
import * as entryRoute from "@/app/api/v1/entries/[id]/route"
import * as readRoute from "@/app/api/v1/entries/[id]/read/route"
import * as readAllRoute from "@/app/api/v1/entries/read/route"
import * as subscriptionsRoute from "@/app/api/v1/subscriptions/route"
import * as subscriptionRoute from "@/app/api/v1/subscriptions/[feedId]/route"
import { db } from "@/test/db"

import * as api from "./api-v1"
import { auth } from "./auth"
import type { SafeFetch } from "./ingest/safe-fetch"

const BASE = "http://localhost:3210/api/v1"
const T = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute))

let key: string

async function user(id: string) {
  await db.user.create({ data: { id, name: id, email: `${id}@example.com` } })
}

beforeEach(async () => {
  await user("u1")
  await user("u2")
  // u1 follows a and b; u2 follows a and c, so a is shared and c is not u1's.
  for (const [id, title, subscribers] of [
    ["a", "Alpha", ["u1", "u2"]],
    ["b", "Beta", ["u1"]],
    ["c", "Gamma", ["u2"]],
  ] as const) {
    await db.feed.create({
      data: {
        id,
        url: `https://${id}.example.com/feed.xml`,
        title,
        subscriptions: { create: subscribers.map((userId) => ({ userId })) },
      },
    })
  }
  for (const [id, feedId, minute] of [
    ["a1", "a", 1],
    ["a2", "a", 2],
    ["b1", "b", 3],
    ["c1", "c", 4],
  ] as const) {
    await db.entry.create({
      data: {
        id,
        feedId,
        guid: id,
        title: `Entry ${id}`,
        sortAt: T(minute),
        contentHtml: `<p>${id}</p>`,
      },
    })
  }
  key = (await auth.api.createApiKey({ body: { userId: "u1" } })).key
})

function call(
  path: string,
  init: { method?: string; body?: unknown; key?: string | null } = {}
) {
  const headers = new Headers()
  const k = init.key === undefined ? key : init.key
  if (k !== null) headers.set("x-api-key", k)
  if (init.body !== undefined) headers.set("content-type", "application/json")
  return new Request(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body:
      init.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body),
  })
}

const params = <T>(value: T) => ({ params: Promise.resolve(value) })

async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  const body = (await response.json()) as {
    error: { code: string; message: string; choices?: string[] }
  }
  expect(body.error.code).toBe(code)
  expect(body.error.message).toBeString()
  return body
}

describe("who is calling", () => {
  test("a valid key reaches its owner's data", async () => {
    const response = await subscriptionsRoute.GET(call("/subscriptions"))
    expect(response.status).toBe(200)
  })

  test("no header, an invalid, revoked or expired key → 401", async () => {
    await error(
      await subscriptionsRoute.GET(call("/subscriptions", { key: null })),
      401,
      "unauthorized"
    )
    await error(
      await subscriptionsRoute.GET(call("/subscriptions", { key: "rss_nope" })),
      401,
      "unauthorized"
    )
    await db.apikey.updateMany({
      where: { referenceId: "u1" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await error(await entriesRoute.GET(call("/entries")), 401, "unauthorized")
    await db.apikey.deleteMany({ where: { referenceId: "u1" } })
    await error(await entriesRoute.GET(call("/entries")), 401, "unauthorized")
  })

  test("the 121st call in a minute → 429 with Retry-After", async () => {
    for (let i = 0; i < 120; i++) {
      expect((await entriesRoute.GET(call("/entries?limit=1"))).status).toBe(
        200
      )
    }
    const response = await entriesRoute.GET(call("/entries?limit=1"))
    await error(response, 429, "rate_limited")
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(
      1
    )
  })

  test("a valid session cookie without a key → 401", async () => {
    const ctx = await auth.$context
    const session = await ctx.internalAdapter.createSession("u1")
    const cookie = await serializeSignedCookie(
      ctx.authCookies.sessionToken.name,
      session.token,
      ctx.secret
    )
    const request = new Request(`${BASE}/subscriptions`, {
      headers: { cookie: cookie.split(";")[0] },
    })
    await error(await subscriptionsRoute.GET(request), 401, "unauthorized")
  })
})

describe("subscriptions", () => {
  test("GET lists the caller's subscriptions with unread counts", async () => {
    await db.readMark.create({ data: { userId: "u1", entryId: "a1" } })
    const response = await subscriptionsRoute.GET(call("/subscriptions"))
    const { subscriptions } = await response.json()
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions[0]).toEqual({
      id: expect.any(String),
      createdAt: expect.any(String),
      unreadCount: 1,
      feed: {
        id: "a",
        url: "https://a.example.com/feed.xml",
        title: "Alpha",
        siteUrl: null,
        pluginId: null,
        status: "ok",
        lastError: null,
        lastSuccessAt: null,
      },
    })
    expect(subscriptions[1].feed.id).toBe("b")
  })

  test("POST a stored feed → 201 with the subscription, then 200", async () => {
    const body = { url: "https://c.example.com/feed.xml" }
    const created = await subscriptionsRoute.POST(
      call("/subscriptions", { method: "POST", body })
    )
    expect(created.status).toBe(201)
    const { subscription } = await created.json()
    expect(subscription).toMatchObject({
      unreadCount: 1,
      feed: { id: "c", title: "Gamma" },
    })
    const again = await subscriptionsRoute.POST(
      call("/subscriptions", { method: "POST", body })
    )
    expect(again.status).toBe(200)
    expect((await again.json()).subscription.id).toBe(subscription.id)
  })

  test("POST with bad input → 400", async () => {
    for (const body of [
      "not json",
      {},
      { url: 7 },
      { url: "https://c.example.com/feed.xml", source: "cursor-blog" },
    ]) {
      await error(
        await subscriptionsRoute.POST(
          call("/subscriptions", { method: "POST", body })
        ),
        400,
        "invalid_input"
      )
    }
  })

  test("POST that cannot subscribe → 422 with the §4 code and sentence", async () => {
    const invalid = await error(
      await subscriptionsRoute.POST(
        call("/subscriptions", { method: "POST", body: { url: "ftp://x" } })
      ),
      422,
      "invalid_url"
    )
    expect(invalid.error.message).toBe("That doesn’t look like a web address.")
    await error(
      await subscriptionsRoute.POST(
        call("/subscriptions", { method: "POST", body: { source: "nope" } })
      ),
      422,
      "not_found"
    )
    expect(await db.subscription.count({ where: { userId: "u1" } })).toBe(2)
  })

  test("POST of a page with several feeds → 422 multiple with choices", async () => {
    const page = "https://blog.example.com/"
    const links = ["/rss.xml", "/atom.xml"]
      .map(
        (href) =>
          `<link rel="alternate" type="application/rss+xml" href="${href}">`
      )
      .join("")
    const fetch: SafeFetch = async (url) => {
      if (url !== page) throw new Error(`unexpected fetch of ${url}`)
      return {
        status: 200,
        url,
        headers: new Headers({ "content-type": "text/html" }),
        text: `<!DOCTYPE html><html><head>${links}</head></html>`,
        kind: "unknown",
      }
    }
    const response = await api.subscribe(
      call("/subscriptions", { method: "POST", body: { url: page } }),
      { fetch }
    )
    const body = await error(response, 422, "multiple")
    expect(body).toEqual({
      error: {
        code: "multiple",
        message: "blog.example.com has more than one feed. Pick one.",
        choices: [
          "https://blog.example.com/rss.xml",
          "https://blog.example.com/atom.xml",
        ],
      },
    })
  })

  test("DELETE by feed id → 204; another user's subscription → 404", async () => {
    const own = await subscriptionRoute.DELETE(
      call("/subscriptions/b", { method: "DELETE" }),
      params({ feedId: "b" })
    )
    expect(own.status).toBe(204)
    expect(await own.text()).toBe("")
    await error(
      await subscriptionRoute.DELETE(
        call("/subscriptions/c", { method: "DELETE" }),
        params({ feedId: "c" })
      ),
      404,
      "not_found"
    )
    expect(await db.subscription.count({ where: { feedId: "c" } })).toBe(1)
  })
})

describe("entries", () => {
  test("GET lists the caller's entries, newest first, with read state", async () => {
    await db.readMark.create({ data: { userId: "u1", entryId: "b1" } })
    const response = await entriesRoute.GET(call("/entries"))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(Object.keys(body).sort()).toEqual(["asOf", "entries", "nextCursor"])
    expect(body.nextCursor).toBeNull()
    expect(new Date(body.asOf).getTime()).not.toBeNaN()
    expect(body.entries.map((e: { id: string }) => e.id)).toEqual([
      "b1",
      "a2",
      "a1",
    ])
    expect(body.entries[0]).toEqual({
      id: "b1",
      feedId: "b",
      feedTitle: "Beta",
      title: "Entry b1",
      url: null,
      author: null,
      summary: null,
      publishedAt: null,
      sortAt: T(3).toISOString(),
      read: true,
    })
  })

  test("GET takes feedId, unread=true, limit and cursor", async () => {
    await db.readMark.create({ data: { userId: "u1", entryId: "a2" } })
    const unread = await (
      await entriesRoute.GET(call("/entries?feedId=a&unread=true"))
    ).json()
    expect(unread.entries.map((e: { id: string }) => e.id)).toEqual(["a1"])
    const first = await (
      await entriesRoute.GET(call("/entries?limit=2"))
    ).json()
    expect(first.entries).toHaveLength(2)
    expect(first.nextCursor).toBeString()
    const next = await (
      await entriesRoute.GET(
        call(`/entries?limit=2&cursor=${first.nextCursor}`)
      )
    ).json()
    expect(next.entries.map((e: { id: string }) => e.id)).toEqual(["a1"])
    expect(next.nextCursor).toBeNull()
  })

  test("GET with bad parameters → 400; another user's feed → 404", async () => {
    for (const query of [
      "unread=yes",
      "limit=0",
      "limit=101",
      "limit=ten",
      "cursor=bm9wZQ",
    ]) {
      await error(
        await entriesRoute.GET(call(`/entries?${query}`)),
        400,
        "invalid_input"
      )
    }
    await error(
      await entriesRoute.GET(call("/entries?feedId=c")),
      404,
      "not_found"
    )
  })

  test("GET one entry gives its content and does not mark it read", async () => {
    const response = await entryRoute.GET(
      call("/entries/a1"),
      params({ id: "a1" })
    )
    expect(response.status).toBe(200)
    const { entry } = await response.json()
    expect(entry).toMatchObject({
      id: "a1",
      feedTitle: "Alpha",
      read: false,
      contentHtml: "<p>a1</p>",
    })
    expect(await db.readMark.count()).toBe(0)
    await error(
      await entryRoute.GET(call("/entries/c1"), params({ id: "c1" })),
      404,
      "not_found"
    )
  })

  test("PUT and DELETE …/read are idempotent 204s; others' entries → 404", async () => {
    for (let i = 0; i < 2; i++) {
      const put = await readRoute.PUT(
        call("/entries/a1/read", { method: "PUT" }),
        params({ id: "a1" })
      )
      expect(put.status).toBe(204)
    }
    expect(await db.readMark.count({ where: { userId: "u1" } })).toBe(1)
    for (let i = 0; i < 2; i++) {
      const del = await readRoute.DELETE(
        call("/entries/a1/read", { method: "DELETE" }),
        params({ id: "a1" })
      )
      expect(del.status).toBe(204)
    }
    expect(await db.readMark.count()).toBe(0)
    await error(
      await readRoute.PUT(
        call("/entries/c1/read", { method: "PUT" }),
        params({ id: "c1" })
      ),
      404,
      "not_found"
    )
    await error(
      await readRoute.DELETE(
        call("/entries/c1/read", { method: "DELETE" }),
        params({ id: "c1" })
      ),
      404,
      "not_found"
    )
  })

  test("POST /entries/read marks up to upTo and returns the count", async () => {
    const { asOf } = await (await entriesRoute.GET(call("/entries"))).json()
    const response = await readAllRoute.POST(
      call("/entries/read", {
        method: "POST",
        body: { feedId: "a", upTo: asOf },
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ marked: 2 })
    const all = await readAllRoute.POST(
      call("/entries/read", { method: "POST", body: { upTo: asOf } })
    )
    expect(await all.json()).toEqual({ marked: 1 })
    expect(await db.readMark.count({ where: { userId: "u2" } })).toBe(0)
  })

  test("POST /entries/read with a bad cutoff → 400; another user's feed → 404", async () => {
    for (const body of [{}, { upTo: "yesterday" }, "nope"]) {
      await error(
        await readAllRoute.POST(
          call("/entries/read", { method: "POST", body })
        ),
        400,
        "invalid_input"
      )
    }
    await error(
      await readAllRoute.POST(
        call("/entries/read", {
          method: "POST",
          body: { feedId: "c", upTo: new Date().toISOString() },
        })
      ),
      404,
      "not_found"
    )
  })
})
