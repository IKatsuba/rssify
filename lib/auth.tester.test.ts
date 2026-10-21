import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"

import { db } from "@/test/db"

import { auth, isAdmin, registrationGate } from "./auth"

const originalAdmin = process.env.ADMIN_EMAIL
const originalRegistration = process.env.REGISTRATION_ENABLED

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  process.env.ADMIN_EMAIL = "  Admin@Example.invalid  "
  process.env.REGISTRATION_ENABLED = "false"
})

afterEach(() => {
  restoreEnv("ADMIN_EMAIL", originalAdmin)
  restoreEnv("REGISTRATION_ENABLED", originalRegistration)
})

describe("registration boundary cases", () => {
  test.each([undefined, "", "TRUE", "1", " true "])(
    "registration stays closed for %s",
    async (value) => {
      restoreEnv("REGISTRATION_ENABLED", value)
      await expect(
        registrationGate({
          email: "reader@example.invalid",
          emailVerified: true,
        })
      ).rejects.toMatchObject({
        statusCode: 403,
        body: { code: "signup_disabled" },
      })
    }
  )

  test("admin environment changes take effect without changing a user row", () => {
    const user = { email: "ADMIN@example.invalid", emailVerified: true }
    expect(isAdmin(user)).toBe(true)
    process.env.ADMIN_EMAIL = "other@example.invalid"
    expect(isAdmin(user)).toBe(false)
    process.env.ADMIN_EMAIL = "   "
    expect(isAdmin(user)).toBe(false)
  })

  test("closed registration allows creating the verified admin only", async () => {
    const ctx = await auth.$context
    const admin = await ctx.internalAdapter.createUser(
      {
        name: "Admin",
        email: "admin@example.invalid",
        emailVerified: true,
      },
      { method: "oauth", oauth: { providerId: "vercel" } }
    )
    expect(admin.emailVerified).toBe(true)
    await expect(
      ctx.internalAdapter.createUser(
        {
          name: "Unverified",
          email: "ADMIN@example.invalid",
          emailVerified: false,
        },
        { method: "oauth", oauth: { providerId: "vercel" } }
      )
    ).rejects.toMatchObject({ body: { code: "signup_disabled" } })
    expect(await db.user.count()).toBe(1)
  })

  test("opening registration creates an ordinary user; closing does not invalidate its session", async () => {
    process.env.REGISTRATION_ENABLED = "true"
    const ctx = await auth.$context
    const user = await ctx.internalAdapter.createUser(
      {
        name: "Reader",
        email: "reader@example.invalid",
        emailVerified: false,
      },
      { method: "oauth", oauth: { providerId: "vercel" } }
    )
    const session = await ctx.internalAdapter.createSession(user.id)
    process.env.REGISTRATION_ENABLED = "false"
    const signature = createHmac("sha256", ctx.secret)
      .update(session.token)
      .digest("base64")
    const cookie = `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`
    const result = await auth.api.getSession({
      headers: new Headers({ cookie }),
    })
    expect(result?.user.id).toBe(user.id)
    expect(await db.user.count()).toBe(1)
  })
})

async function createKey() {
  const user = await db.user.create({
    data: {
      id: "tester-key-owner",
      name: "Reader",
      email: "reader@example.invalid",
    },
  })
  return auth.api.createApiKey({ body: { userId: user.id } })
}

describe("API key lifecycle and session separation", () => {
  test("allows 120 verifications and refuses the 121st within the minute", async () => {
    const key = await createKey()
    for (let request = 1; request <= 120; request++) {
      expect(
        (await auth.api.verifyApiKey({ body: { key: key.key } })).valid
      ).toBe(true)
    }
    const limited = await auth.api.verifyApiKey({ body: { key: key.key } })
    expect(limited.valid).toBe(false)
    expect(limited.error?.code).toBe("RATE_LIMITED")
  })

  test("a valid key verifies but cannot supply a browser session", async () => {
    const key = await createKey()
    expect(
      (await auth.api.verifyApiKey({ body: { key: key.key } })).valid
    ).toBe(true)
    expect(
      await auth.api.getSession({
        headers: new Headers({ "x-api-key": key.key }),
      })
    ).toBeNull()
  })

  test("an incorrect key is refused", async () => {
    const key = await createKey()
    expect(
      (await auth.api.verifyApiKey({ body: { key: `${key.key}wrong` } })).valid
    ).toBe(false)
  })

  test("a revoked key is refused", async () => {
    const key = await createKey()
    await db.apikey.delete({ where: { id: key.id } })
    expect(
      (await auth.api.verifyApiKey({ body: { key: key.key } })).valid
    ).toBe(false)
  })

  test("an expired key is refused", async () => {
    const key = await createKey()
    await db.apikey.update({
      where: { id: key.id },
      data: { expiresAt: new Date(Date.now() - 60000) },
    })
    expect(
      (await auth.api.verifyApiKey({ body: { key: key.key } })).valid
    ).toBe(false)
  })
})

describe("auth HTTP responses in process", () => {
  test("key creation without a session returns 401", async () => {
    const response = await auth.handler(
      new Request("http://localhost:3210/api/auth/api-key/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Unauthenticated" }),
      })
    )
    expect(response.status).toBe(401)
    expect(await db.apikey.count()).toBe(0)
  })

  test("no session returns 200 with null", async () => {
    const response = await auth.handler(
      new Request("http://localhost:3210/api/auth/get-session")
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toBeNull()
  })

  test("email/password sign-in is unavailable", async () => {
    const response = await auth.handler(
      new Request("http://localhost:3210/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "reader@example.invalid",
          password: "test-only-placeholder",
        }),
      })
    )
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe("EMAIL_PASSWORD_DISABLED")
  })
})
