import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import { db } from "@/test/db"

import { handleCronRefresh } from "./cron"

let saved: string | undefined
let errors: ReturnType<typeof spyOn>
const secret = "tester-local-secret"
const due = new Date("2020-01-01T00:00:00Z")
const request = (header: string) =>
  new Request("http://localhost/api/cron/refresh", {
    headers: { authorization: header },
  })

beforeEach(async () => {
  saved = process.env.CRON_SECRET
  process.env.CRON_SECRET = secret
  errors = spyOn(console, "error").mockImplementation(() => {})
  await db.user.create({
    data: {
      id: "cron-tester",
      name: "Tester",
      email: "cron-tester@example.com",
    },
  })
  await db.feed.create({
    data: {
      id: "cron-tester",
      url: "https://example.com/tester.xml",
      nextFetchAt: due,
      subscriptions: { create: { userId: "cron-tester" } },
    },
  })
})

afterEach(() => {
  if (saved === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = saved
  errors.mockRestore()
})

describe("cron additional acceptance", () => {
  for (const header of [
    `Bearer tester-local-secreu`,
    `Bearer  ${secret}`,
    `Bearer ${secret}, Bearer ${secret}`,
  ]) {
    test(`non-exact authorization ${JSON.stringify(header)} leaves polling state untouched`, async () => {
      let calls = 0
      const response = await handleCronRefresh(request(header), async () => {
        calls++
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: "unauthorized" })
      expect(calls).toBe(0)
      expect(
        (await db.feed.findUniqueOrThrow({ where: { id: "cron-tester" } }))
          .nextFetchAt
      ).toEqual(due)
    })
  }

  test("missing configuration takes precedence even over a formerly correct header", async () => {
    delete process.env.CRON_SECRET
    let calls = 0
    const response = await handleCronRefresh(
      request(`Bearer ${secret}`),
      async () => {
        calls++
      }
    )
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "not_configured" })
    expect(calls).toBe(0)
    expect(
      (await db.feed.findUniqueOrThrow({ where: { id: "cron-tester" } }))
        .nextFetchAt
    ).toEqual(due)
  })

  test("reclaimed sends reuse the same tick key and change it at the next tick", async () => {
    const calls: string[] = []
    for (const now of [
      "2026-03-01T12:00:00Z",
      "2026-03-01T12:14:59.999Z",
      "2026-03-01T12:15:00Z",
    ]) {
      await db.feed.update({
        where: { id: "cron-tester" },
        data: { nextFetchAt: due },
      })
      const response = await handleCronRefresh(
        request(`Bearer ${secret}`),
        async (_, key) => {
          calls.push(key)
        },
        { now: new Date(now) }
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ claimed: 1, sent: 1, failed: 0 })
    }
    expect(calls).toEqual([
      "cron-tester:2026-03-01T12:00:00.000Z",
      "cron-tester:2026-03-01T12:00:00.000Z",
      "cron-tester:2026-03-01T12:15:00.000Z",
    ])
  })
})
