import { expect, test } from "bun:test"

import { intentQueue } from "./intent-queue"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

for (const initial of [false, true]) {
  for (let mask = 0; mask < 8; mask++) {
    test(`three rapid intents: initial=${initial}, failure mask=${mask}`, async () => {
      const intents = [!initial, initial, !initial]
      const gates = intents.map(deferred)
      const started: boolean[] = []
      const failed: boolean[] = []
      let shown = initial
      let server = initial
      const push = intentQueue({
        confirmed: initial,
        show: (value) => (shown = value),
        failed: (value) => failed.push(value),
        send: async (value: boolean) => {
          const index = started.length
          started.push(value)
          await gates[index].promise
          if (mask & (1 << index)) throw new Error("saved fixture failure")
          server = value
        },
      })
      const pending = intents.map(push)
      expect(shown).toBe(intents[2])
      await Promise.resolve()
      expect(started).toEqual([intents[0]])
      for (let index = 0; index < intents.length; index++) {
        gates[index].resolve()
        await pending[index]
        if (index < 2) expect(shown).toBe(intents[2])
      }
      expect(started).toEqual(intents)
      expect(failed).toEqual(intents.filter((_, index) => mask & (1 << index)))
      expect(shown).toBe(server)
    })
  }
}

test("a stalled entry does not block another entry's queue", async () => {
  const gate = deferred()
  const sent: string[] = []
  const make = (name: string, wait: Promise<void>) =>
    intentQueue({
      confirmed: false,
      send: async () => {
        sent.push(name)
        await wait
      },
      show: () => {},
      failed: () => {
        throw new Error("unexpected failure")
      },
    })
  const a = make("a", gate.promise)(true)
  await make("b", Promise.resolve())(true)
  expect(sent).toEqual(["a", "b"])
  gate.resolve()
  await a
})

test("a synchronous send throw rolls back and does not poison future intent", async () => {
  let shown = false
  const failed: boolean[] = []
  const push = intentQueue({
    confirmed: false,
    show: (value) => (shown = value),
    failed: (value) => failed.push(value),
    send: (value: boolean) => {
      if (value) throw new Error("synchronous failure")
      return Promise.resolve()
    },
  })
  await push(true)
  expect(shown).toBe(false)
  await push(false)
  expect(shown).toBe(false)
  expect(failed).toEqual([true])
})
