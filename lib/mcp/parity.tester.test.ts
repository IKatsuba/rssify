import { expect, test } from "bun:test"

import { POST } from "@/app/api/mcp/route"
import { GET as listEntries } from "@/app/api/v1/entries/route"
import { GET as getEntry } from "@/app/api/v1/entries/[id]/route"
import { GET as listFeeds } from "@/app/api/v1/subscriptions/route"
import { auth } from "@/lib/auth"
import { db } from "@/test/db"
import { callTool } from "@/test/mcp-rpc"

test("API and MCP preserve complete subscription, entry and paging bodies for the same stored data", async () => {
  await db.user.create({
    data: { id: "parity-tester", name: "Tester", email: "parity@example.test" },
  })
  const { key } = await auth.api.createApiKey({
    body: { userId: "parity-tester" },
  })
  const headers = { "x-api-key": key }
  await db.feed.create({
    data: {
      id: "parity-feed",
      url: "https://parity.example.test/feed",
      title: "Feed",
      pluginId: "cursor-blog",
      subscriptions: { create: { userId: "parity-tester" } },
    },
  })
  await db.entry.createMany({
    data: ["a", "b", "c"].map((id) => ({
      id,
      feedId: "parity-feed",
      guid: id,
      title: id,
      sortAt: new Date("2026-01-01T00:00:00Z"),
      contentHtml: `<p>${id}</p>`,
    })),
  })
  const request = (path: string) =>
    new Request(`http://localhost:3210/api/v1${path}`, { headers })
  const tool = async (name: string, args = {}) => {
    const result = await callTool(POST, name, args, { headers })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
    return result.structuredContent!
  }
  expect(await tool("list_feeds")).toEqual(
    await (await listFeeds(request("/subscriptions"))).json()
  )
  let cursor: string | null = null
  const ids: string[] = []
  do {
    const query = new URLSearchParams({ limit: "1" })
    if (cursor) query.set("cursor", cursor)
    const api = await (await listEntries(request(`/entries?${query}`))).json()
    const mcp = await tool("list_entries", {
      limit: 1,
      ...(cursor ? { cursor } : {}),
    })
    expect(Date.parse(mcp.asOf as string)).not.toBeNaN()
    const { asOf: _apiTime, ...apiData } = api
    const { asOf: _mcpTime, ...mcpData } = mcp
    expect(Date.parse(_apiTime)).not.toBeNaN()
    expect(Date.parse(_mcpTime as string)).not.toBeNaN()
    expect(mcpData).toEqual(apiData)
    ids.push(...api.entries.map((entry: { id: string }) => entry.id))
    cursor = api.nextCursor
  } while (cursor)
  expect(ids).toEqual(["c", "b", "a"])
  const context = { params: Promise.resolve({ id: "b" }) }
  expect(await tool("get_entry", { entryId: "b" })).toEqual(
    await (await getEntry(request("/entries/b"), context)).json()
  )
  expect(await db.readMark.count()).toBe(0)
})
