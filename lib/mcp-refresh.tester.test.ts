import { expect, test } from "bun:test"

import { POST } from "@/app/api/mcp/route"
import { answerJwksInProcess } from "@/test/jwks"
import { mcpRequest, readRpc } from "@/test/mcp-rpc"
import { mintMcpToken } from "@/test/mcp-token"

import { auth, MCP_RESOURCE } from "./auth"
import { db } from "./db"

answerJwksInProcess()

function listFeeds(token?: string) {
  return POST(
    mcpRequest(
      "tools/call",
      { name: "list_feeds" },
      {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }
    )
  )
}

function scopeOf(response: Response) {
  return /scope="([^"]*)"/.exec(
    response.headers.get("www-authenticate") ?? ""
  )?.[1]
}

test.each(["missing", "malformed", "deleted user"])(
  "%s credentials advertise both connection scopes on the actual MCP route",
  async (credential) => {
    let token: string | undefined
    if (credential === "malformed") token = "not-a-jwt"
    if (credential === "deleted user") {
      token = (await mintMcpToken("removed-reader")).access_token
      await db.user.delete({ where: { id: "removed-reader" } })
    }
    const response = await listFeeds(token)
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="http://localhost:3210/.well-known/oauth-protected-resource/api/mcp"'
    )
    expect(new Set(scopeOf(response)?.split(" "))).toEqual(
      new Set(["offline_access", "reader"])
    )
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: null })
  }
)

test("requesting the challenge scopes issues a usable refresh token", async () => {
  const challenge = await listFeeds()
  expect(challenge.status).toBe(401)
  const scope = scopeOf(challenge)
  expect(scope).toBeDefined()
  const tokens = await mintMcpToken("persistent-reader", scope!)
  expect(new Set(tokens.scope.split(" "))).toEqual(
    new Set(["offline_access", "reader"])
  )
  expect(tokens.refresh_token).toBeString()
  expect(tokens.refresh_token!.length).toBeGreaterThan(0)

  const refreshed = await auth.handler(
    new Request("http://localhost:3210/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token!,
        client_id: tokens.clientId,
        resource: MCP_RESOURCE,
      }),
    })
  )
  expect(refreshed.status).toBe(200)
  const renewed = await refreshed.json()
  expect(renewed.access_token).toBeString()
  const response = await listFeeds(renewed.access_token)
  expect(response.status).toBe(200)
  expect((await readRpc(response)).result.structuredContent).toEqual({
    subscriptions: [],
  })
})

test("reader-only authorization still calls tools without a refresh token", async () => {
  const tokens = await mintMcpToken("reader-only", "reader")
  expect(tokens.refresh_token).toBeUndefined()
  const response = await listFeeds(tokens.access_token)
  expect(response.status).toBe(200)
  expect((await readRpc(response)).result.structuredContent).toEqual({
    subscriptions: [],
  })
})

test("offline_access alone cannot call tools and the 403 asks only for reader", async () => {
  const tokens = await mintMcpToken("offline-only", "offline_access")
  const response = await listFeeds(tokens.access_token)
  expect(response.status).toBe(403)
  expect(response.headers.get("www-authenticate")).toContain(
    'error="insufficient_scope"'
  )
  expect(scopeOf(response)).toBe("reader")
})
