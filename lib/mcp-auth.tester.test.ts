import { expect, test } from "bun:test"

import { answerJwksInProcess } from "@/test/jwks"
import { mintMcpToken } from "@/test/mcp-token"

import { withMcpAuth } from "./actor"
import { auth, MCP_RESOURCE } from "./auth"
import { db } from "./db"

answerJwksInProcess()

const route = withMcpAuth(async (_request, actor) => Response.json(actor))

async function signedRequest(overrides: Record<string, unknown>) {
  await db.user.create({
    data: { id: "edge-user", name: "Reader", email: "edge@example.invalid" },
  })
  const { token } = await auth.api.signJWT({
    body: {
      payload: {
        iss: "http://localhost:3210/api/auth",
        aud: MCP_RESOURCE,
        sub: "edge-user",
        azp: "local-client",
        scope: "reader",
        ...overrides,
      },
    },
  })
  return route(
    new Request(MCP_RESOURCE, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    })
  )
}

test("a real token in the URL and its valid session cookie cannot authenticate MCP", async () => {
  const { access_token, cookie } = await mintMcpToken("query-user")
  const result = await route(
    new Request(
      `${MCP_RESOURCE}?access_token=${encodeURIComponent(access_token)}`,
      {
        method: "POST",
        headers: { cookie },
      }
    )
  )
  expect(result.status).toBe(401)
  expect(result.headers.get("www-authenticate")).toContain("resource_metadata=")
})

test("an issued API key in Bearer form is refused", async () => {
  await db.user.create({
    data: { id: "key-user", name: "Reader", email: "key@example.invalid" },
  })
  const key = await auth.api.createApiKey({ body: { userId: "key-user" } })
  const result = await route(
    new Request(MCP_RESOURCE, {
      method: "POST",
      headers: { authorization: `Bearer ${key.key}` },
    })
  )
  expect(result.status).toBe(401)
})

test.each(["reader-extra", "offline_access reader-extra", "Reader"])(
  "scope %s does not satisfy the exact reader scope",
  async (scope) => {
    const result = await signedRequest({ scope })
    expect(result.status).toBe(403)
    expect(result.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope"'
    )
  }
)

test("a correctly signed token with an empty subject is refused", async () => {
  const result = await signedRequest({ sub: "" })
  expect(result.status).toBe(401)
})

test("a correctly signed token cannot be used before its not-before time", async () => {
  const result = await signedRequest({
    nbf: Math.floor(Date.now() / 1000) + 3600,
  })
  expect(result.status).toBe(401)
})
