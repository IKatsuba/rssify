import { expect, test } from "bun:test"

import { db } from "@/test/db"

import { deleteExpiredAuthRows } from "./auth-cleanup"

test("all expiry boundaries stay intact until the next millisecond, then cleanup is idempotent", async () => {
  const now = new Date("2026-10-22T00:00:00Z")
  await db.user.create({
    data: {
      id: "boundary-user",
      name: "Reader",
      email: "boundary@example.invalid",
    },
  })
  await db.oauthClient.create({
    data: { id: "boundary-client", clientId: "boundary-client" },
  })
  const token = {
    clientId: "boundary-client",
    userId: "boundary-user",
    createdAt: now,
    expiresAt: now,
  }
  await db.oauthRefreshToken.create({
    data: { ...token, id: "boundary-refresh", token: "test-only-refresh" },
  })
  await db.oauthAccessToken.create({
    data: { ...token, id: "boundary-access", token: "test-only-access" },
  })
  await db.oauthClientAssertion.create({
    data: { id: "boundary-assertion", expiresAt: now },
  })
  const empty = { refreshTokens: 0, accessTokens: 0, clientAssertions: 0 }
  expect(await deleteExpiredAuthRows(now)).toEqual(empty)
  expect(await deleteExpiredAuthRows(new Date(now.getTime() + 1))).toEqual({
    refreshTokens: 1,
    accessTokens: 1,
    clientAssertions: 1,
  })
  expect(await deleteExpiredAuthRows(new Date(now.getTime() + 1))).toEqual(
    empty
  )
  expect(await db.user.count()).toBe(1)
  expect(await db.oauthClient.count()).toBe(1)
})
