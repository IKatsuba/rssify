import { readFileSync } from "node:fs"

import { beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createMcpHandler } from "@modelcontextprotocol/server"

import type { SafeFetch } from "@/lib/ingest/safe-fetch"
import * as reader from "@/lib/reader"
import type { SubscribeOptions } from "@/lib/reader"
import { db } from "@/test/db"
import { callTool, type Era, rpc, type ToolResult } from "@/test/mcp-rpc"

import { buildMcpServer } from "./server"

const T = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute))

// The server for one user over the SDK's own handler, as the route serves it.
function serve(userId: string, options?: SubscribeOptions) {
  return createMcpHandler(() => buildMcpServer(userId, options), {
    legacy: "stateless",
  }).fetch
}

const call = (
  name: string,
  args?: Record<string, unknown>,
  {
    userId = "u1",
    options,
    era,
  }: {
    userId?: string
    options?: SubscribeOptions
    era?: Era
  } = {}
) => callTool(serve(userId, options), name, args, { era })

// structuredContent and the one text block carry the same JSON.
function output(result: ToolResult) {
  expect(result.isError).toBeFalsy()
  expect(result.content).toHaveLength(1)
  const json = JSON.parse(result.content[0].text)
  expect(json).toEqual(result.structuredContent!)
  return json
}

function failure(result: ToolResult) {
  expect(result.isError).toBe(true)
  expect(result.structuredContent).toBeUndefined()
  return JSON.parse(result.content[0].text)
}

beforeEach(async () => {
  for (const id of ["u1", "u2"]) {
    await db.user.create({ data: { id, name: id, email: `${id}@example.com` } })
  }
  // u1 follows a and b; u2 follows a and c, so a is shared and c is not u1's.
  for (const [id, title, subscribers, pluginId] of [
    ["a", "Alpha", ["u1", "u2"], null],
    ["b", "Beta", ["u1"], "cursor-blog"],
    ["c", "Gamma", ["u2"], null],
  ] as const) {
    await db.feed.create({
      data: {
        id,
        url: `https://${id}.example.com/feed.xml`,
        title,
        pluginId,
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
        createdAt: T(minute),
        contentHtml: `<p>${id}</p>`,
      },
    })
  }
})

describe("tools/list", () => {
  for (const era of ["modern", "legacy"] as const) {
    test(`is exactly the eight tools, each with an output schema (${era})`, async () => {
      const { body } = await rpc(serve("u1"), "tools/list", {}, { era })
      const tools = body.result.tools as {
        name: string
        inputSchema: { type: string }
        outputSchema?: object
      }[]
      expect(tools.map((t) => t.name).sort()).toEqual([
        "get_entry",
        "list_entries",
        "list_feeds",
        "mark_all_read",
        "mark_read",
        "mark_unread",
        "subscribe",
        "unsubscribe",
      ])
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe("object")
        expect(tool.outputSchema).toBeDefined()
      }
    })
  }
})

describe("list_feeds", () => {
  test("lists the caller's subscriptions with unread counts and pluginId", async () => {
    await db.readMark.create({ data: { userId: "u1", entryId: "a1" } })
    const { subscriptions } = output(await call("list_feeds"))
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions[0]).toMatchObject({
      unreadCount: 1,
      feed: { id: "a", title: "Alpha", pluginId: null, status: "ok" },
    })
    expect(subscriptions[1]).toMatchObject({
      unreadCount: 1,
      feed: { id: "b", pluginId: "cursor-blog" },
    })
    expect(typeof subscriptions[0].createdAt).toBe("string")
  })
})

describe("subscribe", () => {
  const page = "https://blog.example.com/"
  const choices = [
    "https://blog.example.com/rss.xml",
    "https://blog.example.com/atom.xml",
  ]
  const html = `<!DOCTYPE html><html><head>${["/rss.xml", "/atom.xml"]
    .map(
      (href) =>
        `<link rel="alternate" type="application/rss+xml" href="${href}">`
    )
    .join("")}</head></html>`
  const rss = readFileSync("test/fixtures/feeds/claude-dev.rss.xml", "utf8")
  const fetch: SafeFetch = async (url) => {
    if (url === page) {
      const headers = new Headers({ "content-type": "text/html" })
      return { status: 200, url, headers, text: html, kind: "unknown" }
    }
    if (url === choices[0]) {
      return {
        status: 200,
        url,
        headers: new Headers(),
        text: rss,
        kind: "xml",
      }
    }
    throw new Error(`unexpected fetch of ${url}`)
  }

  test("an existing feed subscribes without a fetch", async () => {
    const { subscription } = output(
      await call(
        "subscribe",
        { url: "https://c.example.com/feed.xml" },
        { options: { fetch } }
      )
    )
    expect(subscription).toMatchObject({ unreadCount: 1, feed: { id: "c" } })
  })

  test("multiple returns choices; a second call with one subscribes", async () => {
    const first = failure(
      await call("subscribe", { url: page }, { options: { fetch } })
    )
    expect(first).toEqual({
      code: "multiple",
      message: "blog.example.com has more than one feed. Pick one.",
      choices,
    })
    const { subscription } = output(
      await call("subscribe", { url: first.choices[0] }, { options: { fetch } })
    )
    expect(subscription.feed).toMatchObject({ url: choices[0], pluginId: null })
    expect(subscription.unreadCount).toBeGreaterThan(0)
  })

  test("an unknown source is not_found with the add-feed sentence", async () => {
    expect(failure(await call("subscribe", { source: "nope" }))).toEqual({
      code: "not_found",
      message:
        "We couldn’t find a feed at that address. Try the site’s feed URL directly.",
    })
  })

  test("url and source together are refused before any fetch", async () => {
    const result = await call(
      "subscribe",
      { url: page, source: "claude-code" },
      { options: { fetch } }
    )
    expect(result.isError).toBe(true)
    expect(await db.subscription.count({ where: { userId: "u1" } })).toBe(2)
  })

  test("an unreachable site → unreachable with the add-feed sentence", async () => {
    const down: SafeFetch = async (url) => ({
      status: 503,
      url,
      headers: new Headers(),
      text: "",
      kind: "unknown",
    })
    expect(
      failure(
        await call("subscribe", { url: page }, { options: { fetch: down } })
      )
    ).toEqual({
      code: "unreachable",
      message:
        "We couldn’t reach blog.example.com. Check the address and try again.",
    })
  })

  test("at the 500-feed cap → limit with the add-feed sentence", async () => {
    await db.feed.createMany({
      data: Array.from({ length: 498 }, (_, i) => ({
        id: `cap${i}`,
        url: `https://cap.example.com/${i}.xml`,
      })),
    })
    await db.subscription.createMany({
      data: Array.from({ length: 498 }, (_, i) => ({
        userId: "u1",
        feedId: `cap${i}`,
      })),
    })
    expect(
      failure(await call("subscribe", { url: page }, { options: { fetch } }))
    ).toEqual({
      code: "limit",
      message:
        "You follow 500 feeds, the most rssify allows. Unsubscribe from one first.",
    })
  })
})

// The SDK checks input against the schema before a tool runs and answers
// with its own text; our JSON is for what lib/reader.ts says after that.
test("input the schema refuses is an isError result, not a JSON-RPC error", async () => {
  const { body } = await rpc(serve("u1"), "tools/call", {
    name: "get_entry",
    arguments: { entryId: 42 },
  })
  expect(body.error).toBeUndefined()
  expect(body.result.isError).toBe(true)
  expect(body.result.content[0].text).toStartWith("Input validation error")
})

describe("unsubscribe", () => {
  test("own feed → {}; another user's → not_found and kept", async () => {
    expect(output(await call("unsubscribe", { feedId: "b" }))).toEqual({})
    expect(await db.feed.count({ where: { id: "b" } })).toBe(0)
    expect(failure(await call("unsubscribe", { feedId: "c" }))).toEqual({
      code: "not_found",
      message: "Not found",
    })
    expect(await db.subscription.count({ where: { feedId: "c" } })).toBe(1)
  })
})

describe("list_entries", () => {
  test("lists the caller's entries newest first with read state and asOf", async () => {
    await db.readMark.create({ data: { userId: "u1", entryId: "a2" } })
    const list = output(await call("list_entries"))
    expect(list.entries.map((e: { id: string }) => e.id)).toEqual([
      "b1",
      "a2",
      "a1",
    ])
    expect(list.entries[1]).toMatchObject({
      feedId: "a",
      feedTitle: "Alpha",
      read: true,
      sortAt: T(2).toISOString(),
    })
    expect(list.nextCursor).toBeNull()
    expect(Date.parse(list.asOf)).not.toBeNaN()
    expect(Object.keys(list).sort()).toEqual(["asOf", "entries", "nextCursor"])
  })

  test("unreadOnly, feedId, limit and cursor page", async () => {
    await db.readMark.create({ data: { userId: "u1", entryId: "a2" } })
    const unread = output(await call("list_entries", { unreadOnly: true }))
    expect(unread.entries.map((e: { id: string }) => e.id)).toEqual([
      "b1",
      "a1",
    ])
    const first = output(await call("list_entries", { feedId: "a", limit: 1 }))
    expect(first.entries.map((e: { id: string }) => e.id)).toEqual(["a2"])
    const next = output(
      await call("list_entries", { feedId: "a", cursor: first.nextCursor })
    )
    expect(next.entries.map((e: { id: string }) => e.id)).toEqual(["a1"])
  })

  test("another user's feed → not_found; a bad cursor → invalid_input", async () => {
    expect(failure(await call("list_entries", { feedId: "c" })).code).toBe(
      "not_found"
    )
    expect(failure(await call("list_entries", { cursor: "bad" }))).toEqual({
      code: "invalid_input",
      message: "Invalid cursor",
    })
  })

  test("limit over 100 is refused", async () => {
    expect((await call("list_entries", { limit: 101 })).isError).toBe(true)
  })
})

describe("get_entry", () => {
  test("returns the entry with its content and does not mark it read", async () => {
    const { entry } = output(await call("get_entry", { entryId: "a1" }))
    expect(entry).toMatchObject({
      id: "a1",
      feedTitle: "Alpha",
      contentHtml: "<p>a1</p>",
      read: false,
    })
    expect(await db.readMark.count()).toBe(0)
  })

  test("another user's entry → not_found, and it is not marked read", async () => {
    expect(failure(await call("get_entry", { entryId: "c1" }))).toEqual({
      code: "not_found",
      message: "Not found",
    })
    expect(await db.readMark.count()).toBe(0)
  })
})

describe("mark_read, mark_unread, mark_all_read", () => {
  test("mark_read and mark_unread are idempotent", async () => {
    for (let i = 0; i < 2; i++) {
      expect(output(await call("mark_read", { entryId: "a1" }))).toEqual({})
    }
    expect(await db.readMark.count({ where: { userId: "u1" } })).toBe(1)
    for (let i = 0; i < 2; i++) {
      expect(output(await call("mark_unread", { entryId: "a1" }))).toEqual({})
    }
    expect(await db.readMark.count({ where: { userId: "u1" } })).toBe(0)
  })

  test("another user's entry → not_found, and nothing is marked", async () => {
    expect(failure(await call("mark_read", { entryId: "c1" })).code).toBe(
      "not_found"
    )
    expect(failure(await call("mark_unread", { entryId: "c1" })).code).toBe(
      "not_found"
    )
    expect(await db.readMark.count()).toBe(0)
  })

  test("mark_all_read marks up to asOf, in one feed or all", async () => {
    const { asOf } = output(await call("list_entries"))
    expect(
      output(await call("mark_all_read", { feedId: "a", upTo: asOf }))
    ).toEqual({ marked: 2 })
    expect(output(await call("mark_all_read", { upTo: asOf }))).toEqual({
      marked: 1,
    })
    expect(
      output(await call("mark_all_read", { upTo: T(0).toISOString() }))
    ).toEqual({ marked: 0 })
    expect(
      failure(await call("mark_all_read", { feedId: "c", upTo: asOf })).code
    ).toBe("not_found")
  })

  test("upTo must be an ISO timestamp with an offset", async () => {
    const result = await call("mark_all_read", { upTo: "2026-01-01T00:00:00" })
    expect(result.isError).toBe(true)
    expect(await db.readMark.count()).toBe(0)
  })
})

test("each tool answers in the 2025 era too", async () => {
  const result = await call("get_entry", { entryId: "a1" }, { era: "legacy" })
  expect(output(result).entry.id).toBe("a1")
})

describe("an unexpected failure", () => {
  const secret = 'relation "ReadMark" does not exist at db.internal:5432'
  // Every reader function a tool calls, as one shape spyOn can replace.
  const calls = reader as unknown as Record<string, () => Promise<unknown>>
  const tools: [string, string, Record<string, unknown>][] = [
    ["listSubscriptions", "list_feeds", {}],
    ["subscribe", "subscribe", { url: "https://x.example.com/feed.xml" }],
    ["unsubscribe", "unsubscribe", { feedId: "a" }],
    ["listEntries", "list_entries", {}],
    ["getEntry", "get_entry", { entryId: "a1" }],
    ["markRead", "mark_read", { entryId: "a1" }],
    ["markUnread", "mark_unread", { entryId: "a1" }],
    ["markAllRead", "mark_all_read", { upTo: T(0).toISOString() }],
  ]
  for (const [fn, name, args] of tools) {
    test(`in ${name} is logged, and its message never reaches the client`, async () => {
      const failing = spyOn(calls, fn).mockRejectedValue(new Error(secret))
      const logged = spyOn(console, "error").mockImplementation(() => {})
      try {
        const result = await call(name, args)
        expect(failing).toHaveBeenCalled()
        expect(JSON.stringify(result)).not.toContain("ReadMark")
        expect(failure(result)).toEqual({
          code: "internal_error",
          message: "Something went wrong on our side. Try again in a moment.",
        })
        expect(logged).toHaveBeenCalled()
      } finally {
        failing.mockRestore()
        logged.mockRestore()
      }
    })
  }
})
