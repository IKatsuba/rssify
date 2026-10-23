import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"

import { db } from "@/test/db"
import * as authCleanup from "@/lib/auth-cleanup"

import { handleCronRefresh } from "./cron"

const NOW = new Date("2026-10-22T00:00:00Z")
const savedSecret = process.env.CRON_SECRET

beforeEach(() => {
  process.env.CRON_SECRET = "local-cleanup-test"
})

afterEach(() => {
  if (savedSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = savedSecret
})

function request(authorized = true) {
  return new Request("http://localhost:3210/api/cron/refresh", {
    headers: authorized ? { authorization: "Bearer local-cleanup-test" } : {},
  })
}

async function expiredAssertion() {
  await db.oauthClientAssertion.create({
    data: { id: "expired-assertion", expiresAt: new Date(NOW.getTime() - 1) },
  })
}

test("cleanup runs even when fan-out has no due feeds, and a repeated cron is harmless", async () => {
  await expiredAssertion()
  for (let run = 0; run < 2; run++) {
    const result = await handleCronRefresh(
      request(),
      async () => {
        throw new Error("No feeds should enqueue")
      },
      { now: NOW }
    )
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ claimed: 0, sent: 0, failed: 0 })
    expect(await db.oauthClientAssertion.count()).toBe(0)
  }
})

test("unauthorized cron does not delete expired auth rows", async () => {
  await expiredAssertion()
  const result = await handleCronRefresh(
    request(false),
    async () => {
      throw new Error("Unauthorized requests must not enqueue")
    },
    { now: NOW }
  )
  expect(result.status).toBe(401)
  expect(await db.oauthClientAssertion.count()).toBe(1)
})

test("cleanup failure is logged while successful fan-out counts still return", async () => {
  const failure = new Error("local injected cleanup failure")
  const cleanup = spyOn(authCleanup, "deleteExpiredAuthRows").mockRejectedValue(
    failure
  )
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const result = await handleCronRefresh(request(), async () => {}, {
      now: NOW,
    })
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ claimed: 0, sent: 0, failed: 0 })
    expect(errors).toHaveBeenCalledWith("auth cleanup failed", failure)
  } finally {
    cleanup.mockRestore()
    errors.mockRestore()
  }
})
