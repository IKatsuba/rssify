import { readFileSync } from "node:fs"

import { beforeEach, expect, test } from "bun:test"
import { createMcpHandler } from "@modelcontextprotocol/server"

import { SafeFetchError, type SafeFetch } from "@/lib/ingest/safe-fetch"
import type { SubscribeOptions } from "@/lib/reader"
import { db } from "@/test/db"
import { callTool, type ToolResult } from "@/test/mcp-rpc"

import { buildMcpServer } from "./server"

function call(
  name: string,
  args = {},
  options?: SubscribeOptions,
  user = "tester"
) {
  const handler = createMcpHandler(() => buildMcpServer(user, options), {
    legacy: "stateless",
  })
  return callTool(handler.fetch, name, args)
}

function result(value: ToolResult, error = false) {
  expect(Boolean(value.isError)).toBe(error)
  expect(value.content).toHaveLength(1)
  const json = JSON.parse(value.content[0].text)
  if (!error) expect(value.structuredContent).toEqual(json)
  return json
}

beforeEach(async () => {
  for (const id of ["tester", "other"]) {
    await db.user.create({
      data: { id, name: id, email: `${id}@example.test` },
    })
  }
})

test("empty account lists empty feeds and entries and marks zero", async () => {
  expect(result(await call("list_feeds"))).toEqual({ subscriptions: [] })
  const page = result(await call("list_entries"))
  expect(page.entries).toEqual([])
  expect(page.nextCursor).toBeNull()
  expect(result(await call("mark_all_read", { upTo: page.asOf }))).toEqual({
    marked: 0,
  })
})

for (const [status, code] of [
  [304, "unreachable"],
  [404, "not_found"],
  [429, "unreachable"],
  [500, "unreachable"],
] as const) {
  test(`subscribe HTTP ${status} returns ${code} and writes nothing`, async () => {
    const fetch: SafeFetch = async (url) => ({
      status,
      url,
      headers: new Headers(),
      text: "",
      kind: "unknown",
    })
    expect(
      result(
        await call(
          "subscribe",
          { url: "https://feed.example.test/rss" },
          { fetch }
        ),
        true
      ).code
    ).toBe(code)
    expect(await db.feed.count()).toBe(0)
    expect(await db.subscription.count()).toBe(0)
    expect(await db.entry.count()).toBe(0)
  })
}

for (const code of ["unreachable", "too_large", "blocked"] as const) {
  test(`subscribe propagates guarded ${code} failure without storing a feed`, async () => {
    const fetch: SafeFetch = async () => {
      throw new SafeFetchError(code, "Guarded fetch fixture failure")
    }
    expect(
      result(
        await call(
          "subscribe",
          { url: "https://feed.example.test/rss" },
          { fetch }
        ),
        true
      ).code
    ).toBe(code)
    expect(await db.feed.count()).toBe(0)
  })
}

test("malformed feed is not_found and a valid empty feed can be followed", async () => {
  const fetch: SafeFetch = async (url) => ({
    status: 200,
    url,
    headers: new Headers(),
    text: url.endsWith("broken")
      ? "<rss><channel><"
      : '<rss version="2.0"><channel><title>Empty</title><link>https://feed.example.test/</link><description>Empty feed</description></channel></rss>',
    kind: "xml",
  })
  expect(
    result(
      await call(
        "subscribe",
        { url: "https://feed.example.test/broken" },
        { fetch }
      ),
      true
    ).code
  ).toBe("not_found")
  const added = result(
    await call(
      "subscribe",
      { url: "https://feed.example.test/empty" },
      { fetch }
    )
  )
  expect(added.subscription.unreadCount).toBe(0)
  expect(added.subscription.feed.title).toBe("Empty")
  expect(await db.entry.count()).toBe(0)
})

test("redirected feed keeps input URL and duplicate subscription does not fetch or duplicate entries", async () => {
  const text = readFileSync("test/fixtures/feeds/claude-dev.rss.xml", "utf8")
  let fetches = 0
  const fetch: SafeFetch = async () => {
    fetches++
    return {
      status: 200,
      url: "https://cdn.example.test/final.xml",
      headers: new Headers(),
      text,
      kind: "xml",
    }
  }
  const args = { url: "https://feed.example.test/rss#fragment" }
  const first = result(await call("subscribe", args, { fetch })).subscription
  const count = await db.entry.count()
  const second = result(await call("subscribe", args, { fetch })).subscription
  expect(first.feed.url).toBe("https://feed.example.test/rss")
  expect(second).toEqual(first)
  expect(count).toBeGreaterThan(0)
  expect(await db.entry.count()).toBe(count)
  expect(fetches).toBe(1)
})

test("shared-feed read state stays per-user; unsubscribe preserves the other subscriber", async () => {
  await db.feed.create({
    data: {
      id: "shared",
      url: "https://feed.example.test/shared",
      subscriptions: { create: [{ userId: "tester" }, { userId: "other" }] },
    },
  })
  const cutoff = new Date("2026-01-01T00:00:00Z")
  await db.entry.createMany({
    data: [
      {
        id: "old",
        feedId: "shared",
        guid: "old",
        title: "Old",
        sortAt: cutoff,
        createdAt: cutoff,
      },
      {
        id: "new",
        feedId: "shared",
        guid: "new",
        title: "Backdated arrival",
        sortAt: cutoff,
        createdAt: new Date(cutoff.getTime() + 1),
      },
    ],
  })
  expect(
    result(await call("mark_all_read", { upTo: "2026-01-01T01:00:00+01:00" }))
  ).toEqual({ marked: 1 })
  expect(
    result(await call("get_entry", { entryId: "old" }, undefined, "other"))
      .entry.read
  ).toBe(false)
  expect(result(await call("get_entry", { entryId: "new" })).entry.read).toBe(
    false
  )
  expect(
    result(await call("mark_all_read", { upTo: cutoff.toISOString() }))
  ).toEqual({ marked: 0 })
  result(await call("unsubscribe", { feedId: "shared" }))
  expect(await db.entry.count()).toBe(2)
  expect(
    result(await call("list_entries", {}, undefined, "other")).entries
  ).toHaveLength(2)
  expect(result(await call("get_entry", { entryId: "old" }), true).code).toBe(
    "not_found"
  )
})
