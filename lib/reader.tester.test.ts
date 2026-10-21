import { beforeEach, describe, expect, test } from "bun:test"

import { db } from "@/test/db"

import { getNeighbours, listEntries, listSubscriptions } from "./reader"

const sortAt = new Date("2026-01-01T00:00:00Z")

beforeEach(async () => {
  await db.user.createMany({
    data: ["reader", "other", "empty"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
    })),
  })
  for (const id of ["a", "b", "foreign", "vacant"]) {
    await db.feed.create({
      data: {
        id,
        url: `https://${id}.example.com/feed`,
        subscriptions: {
          create: (id === "foreign" ? ["other"] : ["reader", "other"]).map(
            (userId) => ({ userId })
          ),
        },
      },
    })
  }
  await db.entry.createMany({
    data: Array.from({ length: 9 }, (_, index) => ({
      id: `entry-${index}`,
      guid: `entry-${index}`,
      feedId: index === 7 ? "foreign" : index % 2 ? "a" : "b",
      title: `Entry ${index}`,
      sortAt,
    })),
  })
})

describe("reader tester: read-side boundaries", () => {
  test("unread keyset pages span tied timestamps across feeds without leaking other data", async () => {
    await db.readMark.createMany({
      data: [
        { userId: "reader", entryId: "entry-6" },
        { userId: "reader", entryId: "entry-3" },
        { userId: "other", entryId: "entry-4" },
      ],
    })
    const seen: string[] = []
    let cursor: string | undefined
    for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
      const page = await listEntries("reader", {
        unreadOnly: true,
        limit: 2,
        cursor,
      })
      expect(page.entries.every((entry) => !entry.read)).toBe(true)
      seen.push(...page.entries.map((entry) => entry.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual([
      "entry-8",
      "entry-5",
      "entry-4",
      "entry-2",
      "entry-1",
      "entry-0",
    ])
  })

  test("read anchors skip consecutive read neighbours and foreign feeds at equal timestamps", async () => {
    await db.readMark.createMany({
      data: ["entry-6", "entry-5", "entry-4"].map((entryId) => ({
        userId: "reader",
        entryId,
      })),
    })
    expect(
      await getNeighbours("reader", "entry-5", { unreadOnly: true })
    ).toEqual({ previousId: "entry-8", nextId: "entry-3" })
    expect(
      await getNeighbours("reader", "entry-5", {
        feedId: "a",
        unreadOnly: true,
      })
    ).toEqual({ previousId: null, nextId: "entry-3" })
  })

  test("empty subscriptions and empty feeds return empty pages and zero counts", async () => {
    expect(await listSubscriptions("empty")).toEqual([])
    expect(await listEntries("empty")).toMatchObject({
      entries: [],
      nextCursor: null,
    })
    expect(
      (await listSubscriptions("reader")).find(
        (subscription) => subscription.feed.id === "vacant"
      )?.unreadCount
    ).toBe(0)
    expect(await listEntries("reader", { feedId: "vacant" })).toMatchObject({
      entries: [],
      nextCursor: null,
    })
  })
})
