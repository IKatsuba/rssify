import { beforeEach, expect, test } from "bun:test"

import * as api from "./api-v1"
import { auth } from "./auth"
import { db } from "@/test/db"
import type { SafeFetch } from "./ingest/safe-fetch"

let key: string
const cutoff = new Date("2026-01-01T00:00:00Z")

beforeEach(async () => {
  await db.user.create({
    data: { id: "tester", name: "Tester", email: "tester@example.com" },
  })
  await db.feed.create({
    data: {
      id: "test-feed",
      url: "https://stored.example.com/rss",
      pluginId: "cursor-blog",
      subscriptions: { create: { userId: "tester" } },
      entries: {
        create: ["a", "b", "c"].map((id, index) => ({
          id,
          guid: id,
          title: id,
          sortAt: cutoff,
          createdAt: new Date(cutoff.getTime() + (index === 2 ? 1 : 0)),
        })),
      },
    },
  })
  key = (await auth.api.createApiKey({ body: { userId: "tester" } })).key
})

function request(path = "", method = "GET", body?: string, withKey = true) {
  return new Request(`http://localhost:3210/api/v1${path}`, {
    method,
    headers: withKey ? { "x-api-key": key } : {},
    body,
  })
}

async function refusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({
    error: { code, message: expect.any(String) },
  })
}

test("every adapter authenticates before parsing malformed inputs or exposing ids", async () => {
  const calls = [
    () => api.listSubscriptions(request("", "GET", undefined, false)),
    () => api.subscribe(request("", "POST", "{", false)),
    () => api.unsubscribe(request("", "DELETE", undefined, false), ""),
    () => api.listEntries(request("?limit=garbage", "GET", undefined, false)),
    () => api.getEntry(request("", "GET", undefined, false), ""),
    () => api.markRead(request("", "PUT", undefined, false), ""),
    () => api.markUnread(request("", "DELETE", undefined, false), ""),
    () => api.markAllRead(request("", "POST", "{", false)),
  ]
  for (const call of calls) await refusal(await call(), 401, "unauthorized")
  expect(await db.readMark.count()).toBe(0)
  expect(await db.subscription.count()).toBe(1)
})

test("equal-sortAt keyset pages contain every entry once and GET leaves read marks unchanged", async () => {
  const ids: string[] = []
  let cursor: string | null = null
  do {
    const response = await api.listEntries(
      request(
        `/entries?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      )
    )
    expect(response.status).toBe(200)
    const page = await response.json()
    ids.push(...page.entries.map((entry: { id: string }) => entry.id))
    cursor = page.nextCursor
    expect(ids.length).toBeLessThanOrEqual(3)
  } while (cursor)
  expect(ids).toEqual(["c", "b", "a"])
  expect(await db.readMark.count()).toBe(0)
})

test("bulk read includes cutoff boundary, excludes later arrivals and reports actual count on retry", async () => {
  const body = JSON.stringify({
    feedId: "test-feed",
    upTo: cutoff.toISOString(),
  })
  expect(
    await (await api.markAllRead(request("", "POST", body))).json()
  ).toEqual({ marked: 2 })
  expect(
    await (await api.markAllRead(request("", "POST", body))).json()
  ).toEqual({ marked: 0 })
  expect(
    (await db.readMark.findMany({ orderBy: { entryId: "asc" } })).map(
      (mark) => mark.entryId
    )
  ).toEqual(["a", "b"])
})

test("subscription feed exposes pluginId and never sourceId or polling internals", async () => {
  const { subscriptions } = await (
    await api.listSubscriptions(request())
  ).json()
  expect(subscriptions[0].feed.pluginId).toBe("cursor-blog")
  expect(Object.keys(subscriptions[0].feed).sort()).toEqual([
    "id",
    "lastError",
    "lastSuccessAt",
    "pluginId",
    "siteUrl",
    "status",
    "title",
    "url",
  ])
})

test("fetch HTTP failures surface as 422 without adding feeds or subscriptions", async () => {
  for (const [status, code] of [
    [304, "unreachable"],
    [404, "not_found"],
    [429, "unreachable"],
    [500, "unreachable"],
  ] as const) {
    const fetch: SafeFetch = async (url) => ({
      status,
      url,
      text: "",
      headers: new Headers(),
      kind: "unknown",
    })
    const response = await api.subscribe(
      request(
        "",
        "POST",
        JSON.stringify({ url: `https://new.example.com/${status}` })
      ),
      { fetch }
    )
    await refusal(response, 422, code)
    expect(await db.feed.count()).toBe(1)
    expect(await db.subscription.count()).toBe(1)
  }
})

test("empty, fractional and overflowing query parameters return 400", async () => {
  for (const query of [
    "feedId=",
    "cursor=",
    "limit=",
    "limit=1.5",
    "limit=1e2",
    "limit=-1",
    `limit=${"9".repeat(400)}`,
    "unread=",
  ]) {
    await refusal(
      await api.listEntries(request(`/entries?${query}`)),
      400,
      "invalid_input"
    )
  }
})
