import { describe, expect, test } from "bun:test"

import { GET as authServer } from "@/app/.well-known/oauth-authorization-server/[[...path]]/route"
import { GET as protectedResource } from "@/app/.well-known/oauth-protected-resource/[[...path]]/route"

// Here rather than beside the routes: bun test skips dot-directories.
const ORIGIN = "http://localhost:3210"

describe("protected resource metadata", () => {
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/api/mcp",
  ]) {
    test(path, async () => {
      const res = await protectedResource(new Request(`${ORIGIN}${path}`))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.resource).toBe(`${ORIGIN}/api/mcp`)
      expect(body.authorization_servers).toEqual([`${ORIGIN}/api/auth`])
      expect(body.scopes_supported).toEqual(["reader"])
    })
  }
})

describe("authorization server metadata", () => {
  test("at the issuer path", async () => {
    const res = await authServer(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server/api/auth`)
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.issuer).toBe(`${ORIGIN}/api/auth`)
    expect(body.code_challenge_methods_supported).toContain("S256")
    expect(body.client_id_metadata_document_supported).toBe(true)
    expect(body).not.toHaveProperty("registration_endpoint")
  })
})
