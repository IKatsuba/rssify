import { describe, expect, test } from "bun:test"

import { intentQueue } from "./intent-queue"

describe("intentQueue", () => {
  test("a slow first call finishes before the next one starts", async () => {
    const log: string[] = []
    let release!: () => void
    const slow = new Promise<void>((resolve) => (release = resolve))
    const push = intentQueue(async (intent: string) => {
      log.push(`start ${intent}`)
      if (intent === "read") await slow
      log.push(`end ${intent}`)
    })
    push("read")
    const done = push("unread")
    await Promise.resolve()
    expect(log).toEqual(["start read"])
    release()
    await done
    expect(log).toEqual([
      "start read",
      "end read",
      "start unread",
      "end unread",
    ])
  })

  test("isLatest is false once a newer intent is queued", async () => {
    const seen: [string, boolean][] = []
    const push = intentQueue(async (intent: string, isLatest) => {
      seen.push([intent, isLatest()])
    })
    push("a")
    await push("b")
    expect(seen).toEqual([
      ["a", false],
      ["b", true],
    ])
  })

  test("a failing step does not stop the next", async () => {
    const ran: string[] = []
    const push = intentQueue(async (intent: string) => {
      if (intent === "bad") throw new Error("boom")
      ran.push(intent)
    })
    push("bad")
    await push("good")
    expect(ran).toEqual(["good"])
  })
})
