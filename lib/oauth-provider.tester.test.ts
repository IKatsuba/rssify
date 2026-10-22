import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"

import { db } from "@/test/db"

import { auth } from "./auth"

describe("OAuth provider boundaries", () => {
  test("anonymous dynamic registration is refused without creating a client", async () => {
    const response = await auth.handler(
      new Request("http://localhost:3210/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Local tester",
          application_type: "native",
          token_endpoint_auth_method: "none",
          redirect_uris: ["http://127.0.0.1:9/cb"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "offline_access reader",
        }),
      })
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: "access_denied" })
    expect(await db.oauthClient.count()).toBe(0)
  })

  test("even an authenticated session cannot use the disabled JWT endpoint", async () => {
    await db.user.create({
      data: {
        id: "oauth-tester",
        name: "Reader",
        email: "oauth@example.invalid",
      },
    })
    const ctx = await auth.$context
    const session = await ctx.internalAdapter.createSession("oauth-tester")
    const signature = createHmac("sha256", ctx.secret)
      .update(session.token)
      .digest("base64")
    const cookie = `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`
    const headers = new Headers({ cookie })
    expect((await auth.api.getSession({ headers }))?.user.id).toBe(
      "oauth-tester"
    )
    const response = await auth.handler(
      new Request("http://localhost:3210/api/auth/token", { headers })
    )
    expect(response.status).toBe(404)
  })

  test("deleting a user cascades its grants while retaining the shared client and another user's grants", async () => {
    const now = new Date()
    await db.user.createMany({
      data: ["one", "two"].map((id) => ({
        id,
        name: id,
        email: `${id}@example.invalid`,
      })),
    })
    await db.oauthClient.create({
      data: { id: "client-row", clientId: "shared-client" },
    })
    for (const userId of ["one", "two"]) {
      await db.oauthConsent.create({
        data: {
          id: `consent-${userId}`,
          clientId: "shared-client",
          userId,
          createdAt: now,
          updatedAt: now,
          scopes: ["reader"],
        },
      })
      await db.oauthRefreshToken.create({
        data: {
          id: `refresh-${userId}`,
          token: `test-refresh-${userId}`,
          clientId: "shared-client",
          userId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 60000),
          scopes: ["reader"],
        },
      })
      await db.oauthAccessToken.create({
        data: {
          id: `access-${userId}`,
          token: `test-access-${userId}`,
          clientId: "shared-client",
          userId,
          refreshId: `refresh-${userId}`,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 60000),
          scopes: ["reader"],
        },
      })
    }
    await db.user.delete({ where: { id: "one" } })
    expect(await db.oauthClient.count()).toBe(1)
    const grants = await Promise.all([
      db.oauthConsent.findMany({ select: { userId: true } }),
      db.oauthRefreshToken.findMany({ select: { userId: true } }),
      db.oauthAccessToken.findMany({ select: { userId: true } }),
    ])
    for (const rows of grants) {
      expect(rows).toEqual([{ userId: "two" }])
    }
  })
})
