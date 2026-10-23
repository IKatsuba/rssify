import { describe, expect, test } from "bun:test"

import {
  authorize,
  consent,
  createMcpClient,
  createUserWithSession,
  exchangeCode,
  mintMcpToken,
} from "@/test/mcp-token"

import { auth } from "./auth"
import { db } from "./db"
import { disconnectApp, listConnectedApps } from "./mcp-clients"

// Two apps for u1 and one for u2, each with a consent and a refresh token.
async function setUp() {
  const a = await mintMcpToken("u1")
  const bClient = await createMcpClient(a.cookie, "Other app")
  const { location, verifier } = await authorize(a.cookie, bClient)
  const code = (await consent(a.cookie, location)).searchParams.get("code")!
  await exchangeCode(bClient, code, verifier)
  const u2 = await mintMcpToken("u2")
  return { a, bClient, u2 }
}

function liveTokens(where: { userId: string; clientId: string }) {
  return db.oauthRefreshToken.count({ where: { ...where, revoked: null } })
}

describe("listConnectedApps", () => {
  test("the user's consented apps, newest first, with name and host", async () => {
    const { a, bClient } = await setUp()
    // The provider stores whole seconds, so set the order apart explicitly.
    await db.oauthConsent.updateMany({
      where: { clientId: a.clientId },
      data: { createdAt: new Date("2026-01-01T00:00:00Z") },
    })
    const apps = await listConnectedApps("u1")
    expect(apps.map((app) => app.clientId)).toEqual([bClient, a.clientId])
    expect(apps[0]).toMatchObject({
      name: "Other app",
      host: "client.example.com",
    })
    expect(apps[0].createdAt).toBeInstanceOf(Date)
  })

  test("an app with two consents is one row, dated by the latest", async () => {
    const { a, bClient } = await setUp()
    const later = new Date("2030-01-01T00:00:00Z")
    await db.oauthConsent.create({
      data: {
        id: "second",
        clientId: a.clientId,
        userId: "u1",
        scopes: ["reader"],
        createdAt: later,
        updatedAt: later,
      },
    })
    const apps = await listConnectedApps("u1")
    expect(apps.map((app) => app.clientId)).toEqual([a.clientId, bClient])
    expect(apps[0].createdAt).toEqual(later)
  })

  test("ties on the date are ordered by clientId", async () => {
    const { a, bClient } = await setUp()
    await db.oauthConsent.updateMany({
      where: { userId: "u1" },
      data: { createdAt: new Date("2026-01-01T00:00:00Z") },
    })
    const apps = await listConnectedApps("u1")
    expect(apps.map((app) => app.clientId)).toEqual(
      [a.clientId, bClient].sort()
    )
  })

  test("none when nothing is connected", async () => {
    expect(await listConnectedApps("nobody")).toEqual([])
  })
})

describe("disconnectApp", () => {
  test("deletes the consent and revokes that client's refresh tokens only", async () => {
    const { a, bClient, u2 } = await setUp()
    expect(await liveTokens({ userId: "u1", clientId: a.clientId })).toBe(1)

    expect(await disconnectApp("u1", a.clientId)).toEqual({ ok: true })

    expect(
      await db.oauthConsent.count({
        where: { userId: "u1", clientId: a.clientId },
      })
    ).toBe(0)
    expect(await liveTokens({ userId: "u1", clientId: a.clientId })).toBe(0)
    expect(
      await db.oauthRefreshToken.count({
        where: { userId: "u1", clientId: a.clientId },
      })
    ).toBe(1)
    // The other app and the other user keep theirs.
    expect(await liveTokens({ userId: "u1", clientId: bClient })).toBe(1)
    expect(await liveTokens({ userId: "u2", clientId: u2.clientId })).toBe(1)
    expect(await db.oauthConsent.count()).toBe(2)
  })

  test("an app with two consents loses both, and its tokens", async () => {
    const { a, bClient, u2 } = await setUp()
    await db.oauthConsent.create({
      data: {
        id: "second",
        clientId: a.clientId,
        userId: "u1",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    expect(await disconnectApp("u1", a.clientId)).toEqual({ ok: true })

    expect(
      await db.oauthConsent.count({
        where: { userId: "u1", clientId: a.clientId },
      })
    ).toBe(0)
    expect(await liveTokens({ userId: "u1", clientId: a.clientId })).toBe(0)
    expect(await listConnectedApps("u1")).toMatchObject([{ clientId: bClient }])
    expect(await liveTokens({ userId: "u1", clientId: bClient })).toBe(1)
    expect(await liveTokens({ userId: "u2", clientId: u2.clientId })).toBe(1)
    expect(await db.oauthConsent.count({ where: { userId: "u2" } })).toBe(1)
  })

  test("the revoked refresh token no longer refreshes", async () => {
    const { a } = await setUp()
    await disconnectApp("u1", a.clientId)
    const res = await auth.handler(
      new Request("http://localhost:3210/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: a.refresh_token!,
          client_id: a.clientId,
        }),
      })
    )
    expect(res.status).toBe(400)
  })

  test("the app has to ask again", async () => {
    const { a } = await setUp()
    await disconnectApp("u1", a.clientId)
    const again = await authorize(a.cookie, a.clientId)
    expect(again.location.pathname).toBe("/consent")
  })

  test("another user of the same app keeps their consent and tokens", async () => {
    const a = await mintMcpToken("u1")
    const cookie = await createUserWithSession("u2")
    const { location, verifier } = await authorize(cookie, a.clientId)
    const code = (await consent(cookie, location)).searchParams.get("code")!
    await exchangeCode(a.clientId, code, verifier)

    await disconnectApp("u1", a.clientId)

    expect(await liveTokens({ userId: "u1", clientId: a.clientId })).toBe(0)
    expect(await liveTokens({ userId: "u2", clientId: a.clientId })).toBe(1)
    expect(
      await db.oauthConsent.count({
        where: { userId: "u2", clientId: a.clientId },
      })
    ).toBe(1)
  })

  test("another user's app is not_found and untouched", async () => {
    const { u2 } = await setUp()
    expect(await disconnectApp("u1", u2.clientId)).toEqual({
      ok: false,
      code: "not_found",
    })
    expect(await liveTokens({ userId: "u2", clientId: u2.clientId })).toBe(1)
  })
})
