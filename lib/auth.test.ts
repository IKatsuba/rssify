import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { db } from "@/test/db"

import { auth, isAdmin, MCP_RESOURCE, registrationGate } from "./auth"

const ADMIN = "Admin@Example.com"
const saved = {
  ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  REGISTRATION_ENABLED: process.env.REGISTRATION_ENABLED,
}

function setEnv(name: keyof typeof saved, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  setEnv("ADMIN_EMAIL", ADMIN)
  setEnv("REGISTRATION_ENABLED", "false")
})

afterEach(() => {
  setEnv("ADMIN_EMAIL", saved.ADMIN_EMAIL)
  setEnv("REGISTRATION_ENABLED", saved.REGISTRATION_ENABLED)
})

describe("isAdmin", () => {
  test("verified ADMIN_EMAIL, in any case", () => {
    expect(isAdmin({ email: "admin@example.com", emailVerified: true })).toBe(
      true
    )
    expect(isAdmin({ email: "ADMIN@EXAMPLE.COM", emailVerified: true })).toBe(
      true
    )
  })

  test("unverified ADMIN_EMAIL is not admin", () => {
    expect(isAdmin({ email: "admin@example.com", emailVerified: false })).toBe(
      false
    )
  })

  test("another email is not admin", () => {
    expect(isAdmin({ email: "someone@example.com", emailVerified: true })).toBe(
      false
    )
  })

  test("ADMIN_EMAIL unset: nobody is admin", () => {
    setEnv("ADMIN_EMAIL", undefined)
    expect(isAdmin({ email: "admin@example.com", emailVerified: true })).toBe(
      false
    )
    setEnv("ADMIN_EMAIL", "")
    expect(isAdmin({ email: "", emailVerified: true })).toBe(false)
  })
})

async function gateError(user: { email: string; emailVerified: boolean }) {
  try {
    await registrationGate(user)
    return null
  } catch (e) {
    return e as { statusCode: number; body: { code: string } }
  }
}

describe("registrationGate", () => {
  test("open: anyone gets in", async () => {
    setEnv("REGISTRATION_ENABLED", "true")
    expect(
      await gateError({ email: "new@example.com", emailVerified: false })
    ).toBeNull()
  })

  test("closed: a new account is refused with signup_disabled", async () => {
    const error = await gateError({
      email: "new@example.com",
      emailVerified: true,
    })
    expect(error?.statusCode).toBe(403)
    expect(error?.body.code).toBe("signup_disabled")
  })

  test("closed: the verified admin gets in", async () => {
    expect(
      await gateError({ email: "admin@example.com", emailVerified: true })
    ).toBeNull()
  })

  test("closed: an unverified admin email is refused", async () => {
    const error = await gateError({
      email: "admin@example.com",
      emailVerified: false,
    })
    expect(error?.body.code).toBe("signup_disabled")
  })

  test("closed and ADMIN_EMAIL unset: everyone is refused", async () => {
    setEnv("ADMIN_EMAIL", undefined)
    const error = await gateError({
      email: "admin@example.com",
      emailVerified: true,
    })
    expect(error?.body.code).toBe("signup_disabled")
  })

  test("is wired into user creation and writes no row", async () => {
    const ctx = await auth.$context
    await expect(
      ctx.internalAdapter.createUser(
        { name: "New", email: "new@example.com", emailVerified: true },
        { method: "oauth", oauth: { providerId: "vercel" } }
      )
    ).rejects.toMatchObject({ body: { code: "signup_disabled" } })
    expect(await db.user.count()).toBe(0)
  })
})

describe("api keys", () => {
  test("createApiKey for a user works against the test database", async () => {
    await db.user.create({
      data: { id: "u1", name: "One", email: "one@example.com" },
    })
    const key = await auth.api.createApiKey({ body: { userId: "u1" } })
    expect(key.key.startsWith("rss_")).toBe(true)
    const row = await db.apikey.findFirstOrThrow({
      where: { referenceId: "u1" },
    })
    expect(row.rateLimitMax).toBe(120)
    expect(row.rateLimitTimeWindow).toBe(60_000)
  })
})

describe("MCP provider", () => {
  test("boots with jwt, the OAuth provider and CIMD", async () => {
    const ctx = await auth.$context
    const ids = ctx.options.plugins?.map((p) => p.id)
    expect(ids).toEqual(
      expect.arrayContaining(["jwt", "oauth-provider", "cimd"])
    )
    expect(MCP_RESOURCE).toBe("http://localhost:3210/api/mcp")
  })

  test("serves a signing key from the jwks table", async () => {
    const res = await auth.handler(
      new Request("http://localhost:3210/api/auth/jwks")
    )
    expect(res.status).toBe(200)
    const { keys } = (await res.json()) as { keys: { kid: string }[] }
    expect(keys.length).toBeGreaterThan(0)
    expect(await db.jwks.count()).toBeGreaterThan(0)
  })

  test("jwt's session-to-JWT endpoint is disabled", async () => {
    const res = await auth.handler(
      new Request("http://localhost:3210/api/auth/token")
    )
    expect(res.status).toBe(404)
  })

  test("the OAuth tables exist", async () => {
    expect(await db.oauthClient.count()).toBe(0)
    expect(await db.oauthConsent.count()).toBe(0)
    expect(await db.oauthRefreshToken.count()).toBe(0)
    expect(await db.oauthAccessToken.count()).toBe(0)
    expect(await db.oauthClientAssertion.count()).toBe(0)
  })
})
