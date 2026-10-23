import { beforeEach, expect, test } from "bun:test"

import { POST } from "@/app/api/mcp/route"
import { auth } from "@/lib/auth"
import { db } from "@/test/db"
import { answerJwksInProcess } from "@/test/jwks"
import { callTool, mcpRequest } from "@/test/mcp-rpc"
import { mintMcpToken } from "@/test/mcp-token"

answerJwksInProcess()

let key: string
let token: string

beforeEach(async () => {
  token = (await mintMcpToken("oauth-user")).access_token
  await db.user.create({
    data: { id: "key-user", name: "Key", email: "key@example.test" },
  })
  key = (await auth.api.createApiKey({ body: { userId: "key-user" } })).key
  await db.feed.create({
    data: {
      id: "key-feed",
      url: "https://key.example.test/feed",
      subscriptions: { create: { userId: "key-user" } },
    },
  })
})

test("valid key takes precedence over a different user's valid OAuth token", async () => {
  const result = await callTool(
    POST,
    "list_feeds",
    {},
    { headers: { "x-api-key": key, authorization: `Bearer ${token}` } }
  )
  expect(result.isError).toBeFalsy()
  expect(result.structuredContent?.subscriptions).toMatchObject([
    { feed: { id: "key-feed" } },
  ])
  const oauth = await callTool(
    POST,
    "list_feeds",
    {},
    { headers: { authorization: `Bearer ${token}` } }
  )
  expect(oauth.structuredContent?.subscriptions).toEqual([])
})

test("an empty present key never falls back to a valid token", async () => {
  const response = await POST(
    mcpRequest(
      "tools/list",
      {},
      { headers: { "x-api-key": "", authorization: `Bearer ${token}` } }
    )
  )
  expect(response.status).toBe(401)
})

test("authentication precedes malformed JSON parsing", async () => {
  const response = await POST(
    new Request("http://localhost:3210/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })
  )
  expect(response.status).toBe(401)
  expect(response.headers.get("www-authenticate")).toContain(
    "resource_metadata="
  )
})

test("foreign Origin is refused before an API key spends a rate-limit request", async () => {
  const before = await db.apikey.findFirstOrThrow({
    where: { referenceId: "key-user" },
  })
  const response = await POST(
    mcpRequest(
      "tools/list",
      {},
      { headers: { origin: "https://foreign.example.test", "x-api-key": key } }
    )
  )
  expect(response.status).toBe(403)
  const after = await db.apikey.findUniqueOrThrow({ where: { id: before.id } })
  expect(after.requestCount).toBe(before.requestCount)
  expect(after.lastRequest).toEqual(before.lastRequest)
})
