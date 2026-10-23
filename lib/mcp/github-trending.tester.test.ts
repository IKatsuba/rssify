import { readFileSync } from "node:fs"

import { expect, test } from "bun:test"
import { createMcpHandler } from "@modelcontextprotocol/server"

import type { SafeFetch } from "@/lib/ingest/safe-fetch"
import { db } from "@/test/db"
import { callTool, rpc } from "@/test/mcp-rpc"

import { buildMcpServer } from "./server"

for (const era of ["modern", "legacy"] as const) {
  test(`the advertised trending URL works through MCP (${era})`, async () => {
    await db.user.create({
      data: { id: "trending-mcp", name: "Reader", email: "mcp@example.test" },
    })
    const calls: string[] = []
    const fetch: SafeFetch = async (url) => {
      calls.push(url)
      return {
        url,
        status: 200,
        headers: new Headers(),
        kind: "unknown",
        text: readFileSync(
          "test/fixtures/github-trending/javascript-monthly.html",
          "utf8"
        ),
      }
    }
    const handler = createMcpHandler(
      () => buildMcpServer("trending-mcp", { fetch }),
      { legacy: "stateless" }
    ).fetch
    const listed = await rpc(handler, "tools/list", {}, { era })
    const tool = listed.body.result.tools.find(
      (item: { name: string }) => item.name === "subscribe"
    )
    expect(tool.description).toContain("(a GitHub Trending page works too)")
    for (const url of [
      "http://www.github.com/trending/JavaScript/?since=monthly",
      "https://github.com/trending/javascript?since=monthly",
    ]) {
      const result = await callTool(handler, "subscribe", { url }, { era })
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent).toMatchObject({
        subscription: {
          unreadCount: 17,
          feed: {
            url: "https://github.com/trending/javascript?since=monthly",
            pluginId: "github-trending",
            title: "GitHub trending · javascript · this month",
          },
        },
      })
    }
    expect(calls).toEqual([
      "https://github.com/trending/javascript?since=monthly",
    ])
    expect(await db.feed.count()).toBe(1)
    expect(await db.subscription.count()).toBe(1)
    expect(await db.entry.count()).toBe(17)
  })
}
