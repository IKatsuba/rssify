import { beforeEach, describe, expect, test } from "bun:test"

import { generateKeyPair, SignJWT } from "jose"

import { answerJwksInProcess } from "@/test/jwks"
import {
  authorize,
  consent,
  createMcpClient,
  createUserWithSession,
  mintMcpToken,
  REDIRECT_URI,
} from "@/test/mcp-token"

import { withMcpAuth } from "./actor"
import { auth, MCP_RESOURCE } from "./auth"
import { db } from "./db"

answerJwksInProcess()

const ISSUER = "http://localhost:3210/api/auth"
const METADATA =
  'resource_metadata="http://localhost:3210/.well-known/oauth-protected-resource/api/mcp"'

const route = withMcpAuth(async (_request, actor) => Response.json(actor))

function call(authorization?: string) {
  return route(
    new Request(MCP_RESOURCE, {
      method: "POST",
      headers: authorization ? { authorization } : {},
    })
  )
}

const good = {
  iss: ISSUER,
  aud: MCP_RESOURCE,
  sub: "u1",
  azp: "client-1",
  scope: "reader",
}

// Signed with our own key, so each case fails on its claims alone.
async function ownKeyToken(payload: Record<string, unknown>) {
  const { token } = await auth.api.signJWT({ body: { payload } })
  return token
}

async function expectUnauthorized(res: Response) {
  expect(res.status).toBe(401)
  expect(res.headers.get("www-authenticate")).toContain(METADATA)
  expect((await res.json()).jsonrpc).toBe("2.0")
}

describe("withMcpAuth", () => {
  test("a real token reaches the handler as its user, never admin", async () => {
    const { access_token } = await mintMcpToken("u1")
    const res = await call(`Bearer ${access_token}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ userId: "u1", isAdmin: false })
  })

  test("no Authorization → 401 with the resource metadata", async () => {
    await expectUnauthorized(await call())
  })

  test("Bearer not-a-jwt → 401", async () => {
    await expectUnauthorized(await call("Bearer not-a-jwt"))
  })

  // u1 exists here, so each refusal comes from the token check, not from
  // the user lookup that follows it.
  describe("with the token's user present", () => {
    beforeEach(async () => {
      await db.user.create({
        data: { id: "u1", name: "u1", email: "u1@example.com" },
      })
    })

    test("a token signed by a foreign key → 401", async () => {
      const { privateKey } = await generateKeyPair("EdDSA")
      const { kid } = (await auth.api.getJwks()).keys[0]
      const token = await new SignJWT(good)
        .setProtectedHeader({ alg: "EdDSA", kid })
        .setExpirationTime("1h")
        .sign(privateKey)
      await expectUnauthorized(await call(`Bearer ${token}`))
    })

    test("our key with every claim right passes (control)", async () => {
      const res = await call(`Bearer ${await ownKeyToken(good)}`)
      expect(res.status).toBe(200)
    })

    test("wrong aud → 401", async () => {
      const token = await ownKeyToken({
        ...good,
        aud: "http://localhost:3210/api/other",
      })
      await expectUnauthorized(await call(`Bearer ${token}`))
    })

    test("wrong iss → 401", async () => {
      const token = await ownKeyToken({
        ...good,
        iss: "http://localhost:3210/elsewhere",
      })
      await expectUnauthorized(await call(`Bearer ${token}`))
    })

    test("expired → 401", async () => {
      const past = Math.floor(Date.now() / 1000) - 3600
      const token = await ownKeyToken({ ...good, iat: past - 60, exp: past })
      await expectUnauthorized(await call(`Bearer ${token}`))
    })

    test("no azp → 401", async () => {
      const noAzp: Record<string, unknown> = { ...good }
      delete noAzp.azp
      await expectUnauthorized(await call(`Bearer ${await ownKeyToken(noAzp)}`))
    })
  })

  test("no reader scope → 403 insufficient_scope", async () => {
    const { access_token } = await mintMcpToken("u1", "offline_access")
    const res = await call(`Bearer ${access_token}`)
    expect(res.status).toBe(403)
    const challenge = res.headers.get("www-authenticate")
    expect(challenge).toContain('error="insufficient_scope"')
    expect(challenge).toContain('scope="reader"')
  })

  test("a deleted user's token → 401", async () => {
    const { access_token } = await mintMcpToken("u1")
    await db.user.delete({ where: { id: "u1" } })
    await expectUnauthorized(await call(`Bearer ${access_token}`))
  })
})

describe("consent", () => {
  test("a covering consent is reused; once deleted, authorize asks again", async () => {
    const cookie = await createUserWithSession("u1")
    const clientId = await createMcpClient(cookie)

    const first = await authorize(cookie, clientId)
    expect(first.location.pathname).toBe("/consent")
    await consent(cookie, first.location)

    const again = await authorize(cookie, clientId)
    expect(`${again.location.origin}${again.location.pathname}`).toBe(
      REDIRECT_URI
    )
    expect(again.location.searchParams.get("code")).toBeTruthy()

    await db.oauthConsent.deleteMany({ where: { userId: "u1", clientId } })
    const afterDelete = await authorize(cookie, clientId)
    expect(afterDelete.location.pathname).toBe("/consent")
  })
})
