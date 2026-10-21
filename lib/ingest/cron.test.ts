import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import { db } from "@/test/db"

import { handleCronRefresh } from "./cron"

const NOW = new Date("2026-03-01T12:29:00Z")
const SECRET = "test-cron-secret"

const request = (authorization?: string) =>
  new Request("http://localhost:3210/api/cron/refresh", {
    headers: authorization ? { authorization } : {},
  })

function collect() {
  const calls: [string, string][] = []
  return {
    calls,
    enqueue: async (feedId: string, key: string) => {
      calls.push([feedId, key])
    },
  }
}

const leased = async () =>
  (await db.feed.findUniqueOrThrow({ where: { id: "due" } })).nextFetchAt!

let errors: ReturnType<typeof spyOn>
let saved: string | undefined

beforeEach(async () => {
  saved = process.env.CRON_SECRET
  process.env.CRON_SECRET = SECRET
  errors = spyOn(console, "error").mockImplementation(() => {})
  await db.user.create({
    data: { id: "u1", name: "u1", email: "u1@example.com" },
  })
  await db.feed.create({
    data: {
      id: "due",
      url: "https://due.example.com/feed.xml",
      nextFetchAt: new Date(Date.now() - 60_000),
      subscriptions: { create: { userId: "u1" } },
    },
  })
})

afterEach(() => {
  if (saved === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = saved
  errors.mockRestore()
})

describe("handleCronRefresh", () => {
  for (const value of [undefined, ""]) {
    test(`CRON_SECRET ${value === undefined ? "unset" : "empty"} → 500, nothing claimed`, async () => {
      if (value === undefined) delete process.env.CRON_SECRET
      else process.env.CRON_SECRET = value
      const { calls, enqueue } = collect()
      const response = await handleCronRefresh(request("Bearer "), enqueue)
      expect(response.status).toBe(500)
      expect(errors).toHaveBeenCalled()
      expect(calls).toEqual([])
      expect((await leased()).getTime()).toBeLessThan(Date.now())
    })
  }

  for (const header of [
    undefined,
    SECRET,
    `bearer ${SECRET}`,
    `Bearer ${SECRET}x`,
    "Bearer wrong",
  ]) {
    test(`Authorization ${JSON.stringify(header)} → 401, nothing claimed`, async () => {
      const { calls, enqueue } = collect()
      const response = await handleCronRefresh(request(header), enqueue)
      expect(response.status).toBe(401)
      expect(calls).toEqual([])
      expect((await leased()).getTime()).toBeLessThan(Date.now())
    })
  }

  test("the right header fans out with the tick key and returns counts", async () => {
    const { calls, enqueue } = collect()
    const response = await handleCronRefresh(
      request(`Bearer ${SECRET}`),
      enqueue,
      { now: NOW }
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ claimed: 1, sent: 1, failed: 0 })
    expect(calls).toEqual([["due", "due:2026-03-01T12:15:00.000Z"]])
    expect((await leased()).getTime()).toBeGreaterThan(Date.now())
  })

  test("a failed send is counted", async () => {
    const response = await handleCronRefresh(
      request(`Bearer ${SECRET}`),
      async () => {
        throw new Error("queue down")
      }
    )
    expect(await response.json()).toEqual({ claimed: 1, sent: 0, failed: 1 })
  })
})
