import { expect, test } from "bun:test"

import { GET as authServer } from "@/app/.well-known/oauth-authorization-server/[[...path]]/route"
import { GET as protectedResource } from "@/app/.well-known/oauth-protected-resource/[[...path]]/route"
import { db } from "@/test/db"

const ORIGIN = "http://localhost:3210"

test("root authorization metadata matches issuer-path metadata without identity scopes", async () => {
  const root = await authServer(
    new Request(`${ORIGIN}/.well-known/oauth-authorization-server`)
  )
  const issuerPath = await authServer(
    new Request(`${ORIGIN}/.well-known/oauth-authorization-server/api/auth`)
  )
  expect(root.status).toBe(200)
  expect(root.headers.get("content-type")).toContain("application/json")
  const metadata = await root.json()
  expect(metadata).toEqual(await issuerPath.json())
  expect(metadata.scopes_supported.toSorted()).toEqual([
    "offline_access",
    "reader",
  ])
  expect(metadata.authorization_endpoint).toBe(
    `${ORIGIN}/api/auth/oauth2/authorize`
  )
  expect(metadata.token_endpoint).toBe(`${ORIGIN}/api/auth/oauth2/token`)
  expect(metadata.jwks_uri).toBe(`${ORIGIN}/api/auth/jwks`)
})

test("public discovery ignores forwarded host and credentials without creating a session", async () => {
  for (const handler of [authServer, protectedResource]) {
    const path =
      handler === authServer
        ? "oauth-authorization-server"
        : "oauth-protected-resource"
    const response = await handler(
      new Request(`${ORIGIN}/.well-known/${path}`, {
        headers: {
          "x-forwarded-host": "foreign.example.invalid",
          "x-forwarded-proto": "https",
          authorization: "Bearer invalid",
          "x-api-key": "invalid",
        },
      })
    )
    expect(response.status).toBe(200)
    expect(response.headers.has("set-cookie")).toBe(false)
    const metadata = await response.json()
    expect(metadata.issuer ?? metadata.resource).toBe(
      `${ORIGIN}${handler === authServer ? "/api/auth" : "/api/mcp"}`
    )
  }
  expect(await db.session.count()).toBe(0)
  expect(await db.user.count()).toBe(0)
})
