import { expect, test } from "bun:test"
import { serializeSignedCookie } from "better-call"

import { auth } from "./auth"
import { createApiKey, listApiKeys, revokeApiKey } from "./api-keys"
import { db } from "@/test/db"

async function fixture() {
  await db.user.create({
    data: { id: "key-tester", name: "Tester", email: "key-tester@example.com" },
  })
  const ctx = await auth.$context
  const session = await ctx.internalAdapter.createSession("key-tester")
  const cookie = await serializeSignedCookie(
    ctx.authCookies.sessionToken.name,
    session.token,
    ctx.secret
  )
  const headers = new Headers({ cookie: cookie.split(";")[0] })
  const { key } = await createApiKey(headers, "Existing")
  const [row] = await listApiKeys(headers)
  return { headers, key, id: row.id }
}

test("a valid reader key alone cannot create, list or revoke keys", async () => {
  const { key, id, headers } = await fixture()
  for (const unauthorized of [
    new Headers(),
    new Headers({ "x-api-key": key }),
  ]) {
    await expect(createApiKey(unauthorized, "Forbidden")).rejects.toThrow()
    await expect(listApiKeys(unauthorized)).rejects.toThrow()
    await expect(revokeApiKey(unauthorized, id)).rejects.toThrow()
  }
  expect(await db.apikey.count()).toBe(1)
  expect((await listApiKeys(headers))[0].id).toBe(id)
  expect((await auth.api.verifyApiKey({ body: { key } })).valid).toBe(true)
})

test("key management projects metadata and cannot redisplay the full key after use", async () => {
  const { key, id, headers } = await fixture()
  expect(JSON.stringify(await listApiKeys(headers))).not.toContain(key)
  expect((await listApiKeys(headers))[0].lastRequest).toBeNull()
  expect((await auth.api.verifyApiKey({ body: { key } })).valid).toBe(true)
  expect((await listApiKeys(headers))[0].lastRequest).toBeInstanceOf(Date)
  expect(JSON.stringify(await listApiKeys(headers))).not.toContain(key)
  expect(await revokeApiKey(headers, id)).toEqual({ ok: true })
  expect(await revokeApiKey(headers, id)).toEqual({
    ok: false,
    code: "not_found",
  })
  expect((await auth.api.verifyApiKey({ body: { key } })).valid).toBe(false)
})
