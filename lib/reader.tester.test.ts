import { beforeEach, describe, expect, test } from "bun:test"

import { db } from "@/test/db"

import {
  getNeighbours,
  listEntries,
  listSubscriptions,
  markAllRead,
  markRead,
  markUnread,
  unsubscribe,
} from "./reader"

const sortAt = new Date("2026-01-01T00:00:00Z")

describe("reader tester: write boundaries", () => {
  test("concurrent read and repeated unread calls remain idempotent per user", async () => {
    await Promise.all(
      Array.from({ length: 12 }, () => markRead("reader", "entry-1"))
    )
    await markRead("other", "entry-1")
    expect(await db.readMark.count({ where: { entryId: "entry-1" } })).toBe(2)
    await Promise.all([
      markUnread("reader", "entry-1"),
      markUnread("reader", "entry-1"),
    ])
    expect(
      await db.readMark.findMany({
        where: { entryId: "entry-1" },
        select: { userId: true },
      })
    ).toEqual([{ userId: "other" }])
  })

  test("mark-all includes upTo but excludes late backdated entries", async () => {
    const upTo = new Date("2026-02-01T00:00:00Z")
    await db.entry.updateMany({ data: { createdAt: upTo } })
    await db.entry.update({
      where: { id: "entry-1" },
      data: { createdAt: new Date(upTo.getTime() + 1) },
    })
    expect(await markAllRead("reader", { feedId: "a", upTo })).toEqual({
      marked: 2,
    })
    expect(await markAllRead("reader", { feedId: "a", upTo })).toEqual({
      marked: 0,
    })
    expect(
      (
        await listEntries("reader", { feedId: "a", unreadOnly: true })
      ).entries.map((entry) => entry.id)
    ).toEqual(["entry-1"])
    expect(await db.readMark.count({ where: { userId: "other" } })).toBe(0)
    expect(await db.readMark.count({ where: { entry: { feedId: "b" } } })).toBe(
      0
    )
  })

  test("shared feed and other user's marks survive until final unsubscribe", async () => {
    await markRead("other", "entry-1")
    await unsubscribe("reader", "a")
    expect(await db.feed.findUnique({ where: { id: "a" } })).not.toBeNull()
    expect(await db.readMark.count({ where: { entryId: "entry-1" } })).toBe(1)
    await expect(markRead("reader", "entry-1")).rejects.toMatchObject({
      code: "not_found",
    })
    await expect(markUnread("reader", "entry-1")).rejects.toMatchObject({
      code: "not_found",
    })
    await unsubscribe("other", "a")
    expect(await db.feed.findUnique({ where: { id: "a" } })).toBeNull()
    expect(await db.entry.count({ where: { feedId: "a" } })).toBe(0)
    expect(await db.readMark.count({ where: { entryId: "entry-1" } })).toBe(0)
  })

  test("pruning after visibility check maps failed insert to not_found", async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let deleted!: () => void
    const isDeleted = new Promise<void>((resolve) => (deleted = resolve))
    const pruning = db.$transaction(
      async (tx) => {
        await tx.entry.delete({ where: { id: "entry-1" } })
        deleted()
        await released
      },
      { timeout: 10_000 }
    )
    await isDeleted
    // The visibility query sees the old row; its FK insert waits for this delete.
    const marking = markRead("reader", "entry-1").then(
      () => null,
      (error: unknown) => error
    )
    try {
      const deadline = Date.now() + 3_000
      for (;;) {
        const [{ count }] = await db.$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`
        if (count > 0) break
        if (Date.now() > deadline) throw new Error("mark insert never waited")
        await Bun.sleep(10)
      }
    } finally {
      release()
      await pruning
    }
    expect(await marking).toMatchObject({ code: "not_found" })
    expect(await db.readMark.count({ where: { entryId: "entry-1" } })).toBe(0)
  })
})

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
