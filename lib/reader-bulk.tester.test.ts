import { beforeEach, expect, test } from "bun:test"

import { db } from "@/test/db"

import { listEntries, markAllRead, markRead, unsubscribe } from "./reader"

beforeEach(async () => {
  await db.user.createMany({
    data: ["bulk-reader", "bulk-other"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
    })),
  })
  for (const id of ["bulk-a", "bulk-b"]) {
    await db.feed.create({
      data: {
        id,
        url: `https://${id}.example/rss`,
        subscriptions: {
          create: [{ userId: "bulk-reader" }, { userId: "bulk-other" }],
        },
      },
    })
  }
})

async function entries(feedId: string, count: number) {
  await db.entry.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      id: `${feedId}-${i}`,
      feedId,
      guid: String(i),
      title: `Entry ${i}`,
      sortAt: new Date("2020-01-01"),
      createdAt: new Date("2020-01-01"),
    })),
  })
}

test("snapshot mark-all reaches beyond the visible page and excludes a backdated later arrival", async () => {
  await entries("bulk-a", 55)
  await entries("bulk-b", 1)
  const list = await listEntries("bulk-reader", {
    feedId: "bulk-a",
    unreadOnly: true,
  })
  expect(list.entries).toHaveLength(50)
  expect(list.nextCursor).not.toBeNull()
  await db.entry.create({
    data: {
      id: "late",
      feedId: "bulk-a",
      guid: "late",
      title: "Late arrival, old publication",
      sortAt: new Date("2010-01-01"),
      createdAt: new Date(list.asOf.getTime() + 1),
    },
  })
  expect(
    await markAllRead("bulk-reader", { feedId: "bulk-a", upTo: list.asOf })
  ).toEqual({ marked: 55 })
  expect(await db.readMark.count({ where: { entryId: "late" } })).toBe(0)
  expect(
    await db.readMark.count({ where: { entry: { feedId: "bulk-b" } } })
  ).toBe(0)
  expect(await db.readMark.count({ where: { userId: "bulk-other" } })).toBe(0)
  expect(
    await markAllRead("bulk-reader", { feedId: "bulk-a", upTo: list.asOf })
  ).toEqual({ marked: 0 })
})

test("returned marked count reflects another tab's intervening read", async () => {
  await entries("bulk-a", 2)
  const list = await listEntries("bulk-reader", {
    feedId: "bulk-a",
    unreadOnly: true,
  })
  expect(list.entries).toHaveLength(2)
  await markRead("bulk-reader", "bulk-a-0")
  expect(
    await markAllRead("bulk-reader", { feedId: "bulk-a", upTo: list.asOf })
  ).toEqual({ marked: 1 })
  expect(await db.readMark.count()).toBe(2)
})

test("unsubscribe preserves another subscriber's entries and marks", async () => {
  await entries("bulk-a", 1)
  await markRead("bulk-other", "bulk-a-0")
  await unsubscribe("bulk-reader", "bulk-a")
  expect(await db.feed.count({ where: { id: "bulk-a" } })).toBe(1)
  expect(await db.entry.count({ where: { feedId: "bulk-a" } })).toBe(1)
  expect(
    await db.readMark.count({
      where: { userId: "bulk-other", entryId: "bulk-a-0" },
    })
  ).toBe(1)
})
