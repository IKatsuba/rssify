import { describe, expect, test } from "bun:test"
import { serializeSignedCookie } from "better-call"

import { db } from "@/test/db"

import { requireApiKey } from "./actor"
import { auth } from "./auth"

async function createOwner(id: string) {
  await db.user.create({
    data: {
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
    },
  })
  return auth.api.createApiKey({ body: { userId: id } })
}

describe("actor tester: key isolation", () => {
  test("a verified admin's key still has no admin powers", async () => {
    const previous = process.env.ADMIN_EMAIL
    try {
      process.env.ADMIN_EMAIL = "admin@example.com"
      const { key } = await createOwner("admin")
      expect(await requireApiKey(new Headers({ "x-api-key": key }))).toEqual({
        userId: "admin",
        isAdmin: false,
      })
    } finally {
      if (previous === undefined) delete process.env.ADMIN_EMAIL
      else process.env.ADMIN_EMAIL = previous
    }
  })

  test("a disabled key is refused even when its row still exists", async () => {
    const { key, id } = await createOwner("disabled")
    await db.apikey.update({ where: { id }, data: { enabled: false } })
    const result = await requireApiKey(new Headers({ "x-api-key": key }))
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })

  test("an invalid key cannot fall back to a valid session cookie", async () => {
    await createOwner("session-owner")
    const ctx = await auth.$context
    const session = await ctx.internalAdapter.createSession("session-owner")
    const cookie = await serializeSignedCookie(
      ctx.authCookies.sessionToken.name,
      session.token,
      ctx.secret
    )
    const headers = new Headers({
      cookie: cookie.split(";")[0],
      "x-api-key": "rss_invalid",
    })
    expect(await auth.api.getSession({ headers })).not.toBeNull()
    const result = await requireApiKey(headers)
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(401)
  })

  test("exhausting one key does not rate-limit another key of the same user", async () => {
    const first = await createOwner("limited")
    const second = await auth.api.createApiKey({ body: { userId: "limited" } })
    const headers = new Headers({ "x-api-key": first.key })
    for (let i = 0; i < 120; i++) {
      expect(await requireApiKey(headers)).toEqual({
        userId: "limited",
        isAdmin: false,
      })
    }
    const refused = await requireApiKey(headers)
    expect(refused).toBeInstanceOf(Response)
    expect((refused as Response).status).toBe(429)
    expect(
      await requireApiKey(new Headers({ "x-api-key": second.key }))
    ).toEqual({ userId: "limited", isAdmin: false })
  })
})
