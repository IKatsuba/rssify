import { beforeEach, describe, expect, test } from "bun:test"

import { deleteExpiredAuthRows } from "./auth-cleanup"
import { db } from "./db"

const NOW = new Date("2026-03-01T12:00:00Z")
const PAST = new Date("2026-03-01T11:59:59Z")
const FUTURE = new Date("2026-03-01T12:00:01Z")

const token = (id: string, expiresAt: Date) => ({
  id,
  token: `hash-${id}`,
  clientId: "c1",
  userId: "u1",
  expiresAt,
  createdAt: PAST,
})

beforeEach(async () => {
  await db.user.create({
    data: { id: "u1", name: "u1", email: "u1@example.com" },
  })
  await db.oauthClient.create({ data: { id: "c1", clientId: "c1" } })
  await db.oauthConsent.create({
    data: {
      id: "consent",
      clientId: "c1",
      userId: "u1",
      createdAt: PAST,
      updatedAt: PAST,
    },
  })
  await db.oauthRefreshToken.createMany({
    data: [token("r-old", PAST), token("r-live", FUTURE)],
  })
  await db.oauthAccessToken.createMany({
    data: [token("a-old", PAST), token("a-live", FUTURE)],
  })
  await db.oauthClientAssertion.createMany({
    data: [
      { id: "j-old", expiresAt: PAST },
      { id: "j-live", expiresAt: FUTURE },
    ],
  })
})

const ids = async () => ({
  refresh: (await db.oauthRefreshToken.findMany()).map((r) => r.id),
  access: (await db.oauthAccessToken.findMany()).map((r) => r.id),
  assertions: (await db.oauthClientAssertion.findMany()).map((r) => r.id),
})

describe("deleteExpiredAuthRows", () => {
  test("deletes expired rows only", async () => {
    expect(await deleteExpiredAuthRows(NOW)).toEqual({
      refreshTokens: 1,
      accessTokens: 1,
      clientAssertions: 1,
    })
    expect(await ids()).toEqual({
      refresh: ["r-live"],
      access: ["a-live"],
      assertions: ["j-live"],
    })
  })

  test("keeps clients and consents", async () => {
    await deleteExpiredAuthRows(new Date("2030-01-01T00:00:00Z"))
    expect(await db.oauthClient.count()).toBe(1)
    expect(await db.oauthConsent.count()).toBe(1)
  })

  test("a row expiring exactly now stays until the next run", async () => {
    await db.oauthClientAssertion.create({
      data: { id: "j-now", expiresAt: NOW },
    })
    await deleteExpiredAuthRows(NOW)
    expect((await ids()).assertions.sort()).toEqual(["j-live", "j-now"])
  })
})
