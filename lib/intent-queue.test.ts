import { describe, expect, test } from "bun:test"

import { intentQueue } from "./intent-queue"

function setup(
  confirmed: boolean,
  outcome: (intent: boolean) => Promise<void>
) {
  const log: string[] = []
  let shown = confirmed
  const failures: boolean[] = []
  const push = intentQueue({
    confirmed,
    send: async (intent) => {
      log.push(`start ${intent}`)
      await outcome(intent)
      log.push(`end ${intent}`)
    },
    show: (state) => (shown = state),
    failed: (intent) => failures.push(intent),
  })
  return { push, log, failures, shown: () => shown }
}

describe("intentQueue", () => {
  test("a slow first call finishes before the next one starts", async () => {
    let release!: () => void
    const slow = new Promise<void>((resolve) => (release = resolve))
    const q = setup(false, (intent) => (intent ? slow : Promise.resolve()))
    q.push(true)
    const done = q.push(false)
    await Promise.resolve()
    expect(q.log).toEqual(["start true"])
    expect(q.shown()).toBe(false)
    release()
    await done
    expect(q.log).toEqual([
      "start true",
      "end true",
      "start false",
      "end false",
    ])
    expect(q.shown()).toBe(false)
  })

  test("two failed opposing intents fall back to the confirmed state", async () => {
    for (const confirmed of [false, true]) {
      const q = setup(confirmed, () => Promise.reject(new Error("down")))
      q.push(!confirmed)
      await q.push(confirmed)
      expect(q.shown()).toBe(confirmed)
      expect(q.failures).toEqual([!confirmed, confirmed])
    }
  })

  test("a failed newest intent falls back to the last success", async () => {
    const q = setup(false, (intent) =>
      intent ? Promise.resolve() : Promise.reject(new Error("down"))
    )
    q.push(true)
    await q.push(false)
    expect(q.shown()).toBe(true)
  })

  test("an older failure leaves a newer intent shown", async () => {
    const q = setup(false, (intent) =>
      intent ? Promise.reject(new Error("down")) : Promise.resolve()
    )
    q.push(true)
    const done = q.push(false)
    await done
    expect(q.shown()).toBe(false)
    expect(q.failures).toEqual([true])
  })

  test("a failing step does not stop the next", async () => {
    const q = setup(false, (intent) =>
      intent ? Promise.reject(new Error("down")) : Promise.resolve()
    )
    q.push(true)
    await q.push(false)
    expect(q.log).toEqual(["start true", "start false", "end false"])
  })
})
