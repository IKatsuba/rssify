import { beforeEach, describe, expect, test } from "bun:test"
import { serializeSignedCookie } from "better-call"

import { db } from "@/test/db"

import { type Actor, requireApiKey } from "./actor"
import { auth } from "./auth"

let key: string

beforeEach(async () => {
  await db.user.create({
    data: { id: "u1", name: "One", email: "one@example.com" },
  })
  key = (await auth.api.createApiKey({ body: { userId: "u1" } })).key
})

function withKey(value?: string) {
  const h = new Headers()
  if (value !== undefined) h.set("x-api-key", value)
  return h
}

async function expectRefused(result: Actor | Response, status: number) {
  expect(result).toBeInstanceOf(Response)
  const response = result as Response
  expect(response.status).toBe(status)
  const body = (await response.json()) as { error: { code: string } }
  expect(body.error.code).toBe(status === 429 ? "rate_limited" : "unauthorized")
  return response
}

describe("requireApiKey", () => {
  test("a valid key gives its owner, never admin", async () => {
    expect(await requireApiKey(withKey(key))).toEqual({
      userId: "u1",
      isAdmin: false,
    })
  })

  test("no header → 401", async () => {
    await expectRefused(await requireApiKey(withKey()), 401)
  })

  test("an invalid key → 401", async () => {
    await expectRefused(await requireApiKey(withKey("rss_nope")), 401)
  })

  test("a revoked (deleted) key → 401", async () => {
    await db.apikey.deleteMany({ where: { referenceId: "u1" } })
    await expectRefused(await requireApiKey(withKey(key)), 401)
  })

  test("an expired key → 401", async () => {
    await db.apikey.updateMany({
      where: { referenceId: "u1" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await expectRefused(await requireApiKey(withKey(key)), 401)
  })

  test("the 121st call in a minute → 429 with Retry-After", async () => {
    for (let i = 0; i < 120; i++) {
      expect(await requireApiKey(withKey(key))).not.toBeInstanceOf(Response)
    }
    const response = await expectRefused(await requireApiKey(withKey(key)), 429)
    const retryAfter = Number(response.headers.get("Retry-After"))
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(60)
  })

  test("a valid session cookie without a key → 401", async () => {
    const ctx = await auth.$context
    const session = await ctx.internalAdapter.createSession("u1")
    const cookie = await serializeSignedCookie(
      ctx.authCookies.sessionToken.name,
      session.token,
      ctx.secret
    )
    const h = new Headers({ cookie: cookie.split(";")[0] })
    expect(await auth.api.getSession({ headers: h })).not.toBeNull()
    await expectRefused(await requireApiKey(h), 401)
  })
})
