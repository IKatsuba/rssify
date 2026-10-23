import { afterEach, describe, expect, mock, test } from "bun:test"

import { db } from "@/test/db"
import { createUserWithSession } from "@/test/mcp-token"

// Outside Next there is no request; an empty one has no session cookie.
// A test that needs a session sets the cookie here; better-auth may write
// the session cache cookie back, which a test can drop.
let requestHeaders = new Headers()
mock.module("next/headers", () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}))
// revalidatePath needs Next's request store, which a test does not have.
mock.module("next/cache", () => ({ revalidatePath: () => {} }))

const actions = await import("./actions")

async function redirectOf(call: () => Promise<unknown>) {
  try {
    await call()
  } catch (e) {
    return (e as { digest?: string }).digest
  }
  throw new Error("expected a redirect")
}

describe("reader actions without a session", () => {
  const calls: [string, () => Promise<unknown>][] = [
    ["subscribe", () => actions.subscribe({ url: "https://example.com" })],
    ["subscribe a source", () => actions.subscribe({ source: "claude-code" })],
    ["unsubscribe", () => actions.unsubscribe("f1")],
    ["markRead", () => actions.markRead("e1")],
    ["markUnread", () => actions.markUnread("e1")],
    ["markAllRead", () => actions.markAllRead({ upTo: new Date() })],
    [
      "markAllRead with junk",
      () => actions.markAllRead({ feedId: "f1", upTo: "nope" }),
    ],
    ["createApiKey", () => actions.createApiKey("Reader app")],
    ["createApiKey with junk", () => actions.createApiKey("")],
    ["revokeApiKey", () => actions.revokeApiKey("k1")],
    ["disconnectApp", () => actions.disconnectApp("c1")],
    ["disconnectApp with junk", () => actions.disconnectApp("")],
    ["deleteUser", () => actions.deleteUser("u2")],
    ["deleteUser with junk", () => actions.deleteUser("")],
  ]
  for (const [name, call] of calls) {
    test(`${name} redirects to /sign-in`, async () => {
      expect(await redirectOf(call)).toStartWith(
        "NEXT_REDIRECT;replace;/sign-in;"
      )
    })
  }
})

describe("deleteUser", () => {
  const adminEmail = process.env.ADMIN_EMAIL
  afterEach(() => {
    requestHeaders = new Headers()
    process.env.ADMIN_EMAIL = adminEmail
  })

  async function signIn(id: string) {
    requestHeaders = new Headers({ cookie: await createUserWithSession(id) })
  }

  test("a signed-in non-admin gets a 404 and nothing is deleted", async () => {
    process.env.ADMIN_EMAIL = "admin@example.com"
    await signIn("u1")
    await createUserWithSession("u2")
    expect(await redirectOf(() => actions.deleteUser("u2"))).toBe(
      "NEXT_HTTP_ERROR_FALLBACK;404"
    )
    expect(await db.user.count({ where: { id: "u2" } })).toBe(1)
  })

  test("the admin cannot delete themselves", async () => {
    process.env.ADMIN_EMAIL = "admin@example.com"
    await signIn("admin")
    expect(actions.deleteUser("admin")).rejects.toThrow(TypeError)
    expect(await db.user.count({ where: { id: "admin" } })).toBe(1)
  })

  test("the admin deletes another user", async () => {
    process.env.ADMIN_EMAIL = "admin@example.com"
    await signIn("admin")
    await createUserWithSession("u2")
    expect(await actions.deleteUser("u2")).toEqual({ ok: true })
    expect(await db.user.count({ where: { id: "u2" } })).toBe(0)
  })
})
