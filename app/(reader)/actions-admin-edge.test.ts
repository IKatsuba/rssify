import { afterEach, expect, mock, test } from "bun:test"

import { db } from "@/test/db"
import { createUserWithSession } from "@/test/mcp-token"

import { auth } from "@/lib/auth"

let requestHeaders = new Headers()
mock.module("next/headers", () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}))
mock.module("next/cache", () => ({ revalidatePath: () => {} }))
const { deleteUser } = await import("./actions")
const adminEmail = process.env.ADMIN_EMAIL
afterEach(() => {
  requestHeaders = new Headers()
  process.env.ADMIN_EMAIL = adminEmail
})

async function digest(call: () => Promise<unknown>) {
  try {
    await call()
  } catch (error) {
    return (error as { digest?: string }).digest
  }
  throw new Error("Expected authorization refusal")
}

test("non-admin authorization precedes malformed delete input", async () => {
  process.env.ADMIN_EMAIL = "admin@example.com"
  requestHeaders.set("cookie", await createUserWithSession("reader"))
  expect(await digest(() => deleteUser(""))).toBe(
    "NEXT_HTTP_ERROR_FALLBACK;404"
  )
})

test("matching but unverified email cannot delete another user", async () => {
  process.env.ADMIN_EMAIL = "admin@example.com"
  const cookie = await createUserWithSession("admin")
  await db.user.update({
    where: { id: "admin" },
    data: { emailVerified: false },
  })
  await createUserWithSession("victim")
  requestHeaders.set("cookie", cookie)
  expect(await digest(() => deleteUser("victim"))).toBe(
    "NEXT_HTTP_ERROR_FALLBACK;404"
  )
  expect(await db.user.count({ where: { id: "victim" } })).toBe(1)
})

test("verified admin validates malformed ids without deleting anyone", async () => {
  process.env.ADMIN_EMAIL = "  ADMIN@example.com  "
  requestHeaders.set("cookie", await createUserWithSession("admin"))
  await expect(deleteUser("")).rejects.toThrow(TypeError)
  expect(await db.user.count()).toBe(1)
})

test("unset admin configuration denies a verified session", async () => {
  delete process.env.ADMIN_EMAIL
  requestHeaders.set("cookie", await createUserWithSession("admin"))
  expect(await digest(() => deleteUser("absent"))).toBe(
    "NEXT_HTTP_ERROR_FALLBACK;404"
  )
})

test("an admin's API key alone cannot authorize user deletion", async () => {
  process.env.ADMIN_EMAIL = "admin@example.com"
  await createUserWithSession("admin")
  await createUserWithSession("victim")
  const { key } = await auth.api.createApiKey({ body: { userId: "admin" } })
  requestHeaders.set("x-api-key", key)
  expect(await digest(() => deleteUser("victim"))).toStartWith(
    "NEXT_REDIRECT;replace;/sign-in;"
  )
  expect(await db.user.count({ where: { id: "victim" } })).toBe(1)
})

test("deleting a user invalidates their existing session and API key", async () => {
  process.env.ADMIN_EMAIL = "admin@example.com"
  requestHeaders.set("cookie", await createUserWithSession("admin"))
  const cookie = await createUserWithSession("victim")
  const { key } = await auth.api.createApiKey({ body: { userId: "victim" } })
  expect(await deleteUser("victim")).toEqual({ ok: true })
  expect(
    await auth.api.getSession({ headers: new Headers({ cookie }) })
  ).toBeNull()
  expect((await auth.api.verifyApiKey({ body: { key } })).valid).toBe(false)
})
