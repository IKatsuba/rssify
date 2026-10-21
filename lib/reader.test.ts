import { beforeEach, describe, expect, test } from "bun:test"

import { db } from "@/test/db"

import {
  getEntry,
  getNeighbours,
  listEntries,
  listSubscriptions,
  ReaderError,
} from "./reader"

const T = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute))

async function user(id: string) {
  await db.user.create({
    data: { id, name: id, email: `${id}@example.com` },
  })
}

async function feed(id: string, title: string | null, subscribers: string[]) {
  await db.feed.create({
    data: {
      id,
      url: `https://${id}.example.com/feed.xml`,
      title,
      subscriptions: { create: subscribers.map((userId) => ({ userId })) },
    },
  })
}

async function entry(id: string, feedId: string, sortAt: Date) {
  await db.entry.create({
    data: { id, feedId, guid: id, title: `Entry ${id}`, sortAt },
  })
}

async function read(userId: string, entryId: string) {
  await db.readMark.create({ data: { userId, entryId } })
}

async function code(promise: Promise<unknown>) {
  try {
    await promise
    return null
  } catch (e) {
    if (e instanceof ReaderError) return e.code
    throw e
  }
}

beforeEach(async () => {
  await user("u1")
  await user("u2")
  // u1 follows b and a; u2 follows a and c, so a is shared.
  await feed("a", "Alpha", ["u1", "u2"])
  await feed("b", "beta", ["u1"])
  await feed("c", "Gamma", ["u2"])
  await entry("a1", "a", T(1))
  await entry("a2", "a", T(2))
  await entry("b1", "b", T(3))
  await entry("c1", "c", T(4))
})

describe("listSubscriptions", () => {
  test("sorted by title, with per-user unread counts and the feed shape", async () => {
    await read("u1", "a1")
    await read("u2", "a2")
    const subs = await listSubscriptions("u1")
    expect(subs.map((s) => [s.feed.title, s.unreadCount])).toEqual([
      ["Alpha", 1],
      ["beta", 1],
    ])
    expect(Object.keys(subs[0].feed).sort()).toEqual(
      [
        "id",
        "url",
        "title",
        "siteUrl",
        "sourceId",
        "status",
        "lastError",
        "lastSuccessAt",
      ].sort()
    )
    expect(subs[0].feed.sourceId).toBeNull()
    expect(subs[0].id).toBeString()
    expect(subs[0].createdAt).toBeInstanceOf(Date)
  })

  test("a feed with every entry read counts 0", async () => {
    await read("u1", "b1")
    const subs = await listSubscriptions("u1")
    expect(subs.find((s) => s.feed.id === "b")?.unreadCount).toBe(0)
  })
})

describe("listEntries", () => {
  test("all of the user's feeds, newest first, with read and feedTitle", async () => {
    await read("u1", "a2")
    const { entries, nextCursor, asOf } = await listEntries("u1")
    expect(entries.map((e) => [e.id, e.read, e.feedTitle])).toEqual([
      ["b1", false, "beta"],
      ["a2", true, "Alpha"],
      ["a1", false, "Alpha"],
    ])
    expect(nextCursor).toBeNull()
    expect(asOf).toBeInstanceOf(Date)
    expect(entries[0]).not.toHaveProperty("contentHtml")
  })

  test("one feed, and the unread filter", async () => {
    await read("u1", "a2")
    const feedOnly = await listEntries("u1", { feedId: "a" })
    expect(feedOnly.entries.map((e) => e.id)).toEqual(["a2", "a1"])
    const unread = await listEntries("u1", { unreadOnly: true })
    expect(unread.entries.map((e) => e.id)).toEqual(["b1", "a1"])
    // Another user's read mark does not hide it.
    const other = await listEntries("u2", { feedId: "a", unreadOnly: true })
    expect(other.entries.map((e) => e.id)).toEqual(["a2", "a1"])
  })

  test("keyset paging across equal sortAt neither skips nor repeats", async () => {
    for (const id of ["e1", "e2", "e3", "e4", "e5"]) {
      await entry(id, "b", T(10))
    }
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await listEntries("u1", { feedId: "b", limit: 2, cursor })
      expect(page.entries.length).toBeLessThanOrEqual(2)
      seen.push(...page.entries.map((e) => e.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(seen).toEqual(["e5", "e4", "e3", "e2", "e1", "b1"])
  })

  test("limit is capped at 100 and defaults to 50", async () => {
    await db.entry.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        id: `m${String(i).padStart(3, "0")}`,
        feedId: "b",
        guid: `m${i}`,
        title: "m",
        sortAt: T(100),
      })),
    })
    expect((await listEntries("u1")).entries).toHaveLength(50)
    expect((await listEntries("u1", { limit: 500 })).entries).toHaveLength(100)
  })

  test("a feed the user does not follow is not_found; a bad cursor is invalid_cursor", async () => {
    expect(await code(listEntries("u1", { feedId: "c" }))).toBe("not_found")
    expect(await code(listEntries("u1", { feedId: "nope" }))).toBe("not_found")
    expect(await code(listEntries("u1", { cursor: "garbage" }))).toBe(
      "invalid_cursor"
    )
  })
})

describe("getEntry", () => {
  test("returns the entry with content and does not mark it read", async () => {
    await db.entry.update({
      where: { id: "a1" },
      data: { contentHtml: "<p>hi</p>" },
    })
    const e = await getEntry("u1", "a1")
    expect(e).toMatchObject({
      id: "a1",
      feedTitle: "Alpha",
      read: false,
      contentHtml: "<p>hi</p>",
    })
    expect(await db.readMark.count()).toBe(0)
  })

  test("another user's entry, or an unknown one, is not_found", async () => {
    expect(await code(getEntry("u1", "c1"))).toBe("not_found")
    expect(await code(getEntry("u1", "missing"))).toBe("not_found")
  })
})

describe("getNeighbours", () => {
  test("previous is newer, next is older, in the same scope", async () => {
    expect(await getNeighbours("u1", "a2")).toEqual({
      previousId: "b1",
      nextId: "a1",
    })
    expect(await getNeighbours("u1", "a2", { feedId: "a" })).toEqual({
      previousId: null,
      nextId: "a1",
    })
  })

  test("unread filter skips read entries, anchored even on a read one", async () => {
    await read("u1", "a2")
    expect(await getNeighbours("u1", "a2", { unreadOnly: true })).toEqual({
      previousId: "b1",
      nextId: "a1",
    })
    await read("u1", "a1")
    expect(await getNeighbours("u1", "b1", { unreadOnly: true })).toEqual({
      previousId: null,
      nextId: null,
    })
  })

  test("equal sortAt ties are ordered by id", async () => {
    await entry("t1", "b", T(3))
    await entry("t2", "b", T(3))
    // Order: t2, t1, b1 (ids desc within the same sortAt).
    expect(await getNeighbours("u1", "t1", { feedId: "b" })).toEqual({
      previousId: "t2",
      nextId: "b1",
    })
  })

  test("another user's entry or feed is not_found", async () => {
    expect(await code(getNeighbours("u1", "c1"))).toBe("not_found")
    expect(await code(getNeighbours("u1", "a1", { feedId: "c" }))).toBe(
      "not_found"
    )
  })
})
