import { beforeEach, describe, expect, test } from "bun:test"
import { serializeSignedCookie } from "better-call"

import { db } from "@/test/db"

import { requireApiKey } from "./actor"
import { createApiKey, listApiKeys, revokeApiKey } from "./api-keys"
import { auth } from "./auth"

// Session headers as the browser sends them to a server action.
async function sessionHeaders(userId: string) {
  const ctx = await auth.$context
  const session = await ctx.internalAdapter.createSession(userId)
  const cookie = await serializeSignedCookie(
    ctx.authCookies.sessionToken.name,
    session.token,
    ctx.secret
  )
  return new Headers({ cookie: cookie.split(";")[0] })
}

let u1: Headers
let u2: Headers

beforeEach(async () => {
  for (const id of ["u1", "u2"]) {
    await db.user.create({ data: { id, name: id, email: `${id}@example.com` } })
  }
  u1 = await sessionHeaders("u1")
  u2 = await sessionHeaders("u2")
})

describe("createApiKey", () => {
  test("gives the whole key once, owned by the session's user", async () => {
    const { key } = await createApiKey(u1, "NetNewsWire")
    expect(key).toStartWith("rss_")
    expect(await requireApiKey(new Headers({ "x-api-key": key }))).toEqual({
      userId: "u1",
      isAdmin: false,
    })
    const [row] = await db.apikey.findMany()
    expect(row).toMatchObject({ name: "NetNewsWire", referenceId: "u1" })
    expect(row.key).not.toBe(key)
  })

  test("takes a 64-character name", async () => {
    await createApiKey(u1, "x".repeat(64))
    expect((await listApiKeys(u1))[0].name).toHaveLength(64)
  })

  test("without a session it refuses", async () => {
    await expect(createApiKey(new Headers(), "x")).rejects.toThrow()
    expect(await db.apikey.count()).toBe(0)
  })
})

describe("listApiKeys", () => {
  test("lists only the session's keys, newest first, without the key", async () => {
    await createApiKey(u1, "First")
    await new Promise((resolve) => setTimeout(resolve, 5))
    const { key } = await createApiKey(u1, "Second")
    await createApiKey(u2, "Theirs")
    await requireApiKey(new Headers({ "x-api-key": key }))
    const keys = await listApiKeys(u1)
    expect(keys.map((k) => k.name)).toEqual(["Second", "First"])
    expect(Object.keys(keys[0]).sort()).toEqual(
      ["id", "name", "start", "createdAt", "lastRequest"].sort()
    )
    expect(keys[0].start).toBe(key.slice(0, 8))
    expect(keys[0].createdAt).toBeInstanceOf(Date)
    expect(keys[0].lastRequest).toBeInstanceOf(Date)
    expect(keys[1].lastRequest).toBeNull()
  })

  test("an account with no keys lists none", async () => {
    expect(await listApiKeys(u1)).toEqual([])
  })
})

describe("revokeApiKey", () => {
  test("deletes the key, and it stops working at once", async () => {
    const { key } = await createApiKey(u1, "Script")
    const [{ id }] = await listApiKeys(u1)
    expect(await revokeApiKey(u1, id)).toEqual({ ok: true })
    expect(await listApiKeys(u1)).toEqual([])
    const refused = await requireApiKey(new Headers({ "x-api-key": key }))
    expect((refused as Response).status).toBe(401)
  })

  test("another user's key or an unknown id → not_found, nothing deleted", async () => {
    await createApiKey(u2, "Theirs")
    const [{ id }] = await listApiKeys(u2)
    expect(await revokeApiKey(u1, id)).toEqual({
      ok: false,
      code: "not_found",
    })
    expect(await revokeApiKey(u1, "missing")).toEqual({
      ok: false,
      code: "not_found",
    })
    expect(await db.apikey.count()).toBe(1)
  })
})
