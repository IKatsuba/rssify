import { beforeEach, describe, expect, test } from "bun:test"

import { db } from "@/test/db"

import type { SafeFetch } from "./ingest/safe-fetch"

import {
  getEntry,
  getEntryNavigation,
  getNeighbours,
  listEntries,
  listSubscriptions,
  markAllRead,
  markRead,
  markUnread,
  ReaderError,
  subscribe,
  unsubscribe,
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
        "pluginId",
        "status",
        "lastError",
        "lastSuccessAt",
      ].sort()
    )
    expect(subs[0].feed.pluginId).toBeNull()
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

  test("before steps back up through the same pages", async () => {
    for (const id of ["e1", "e2", "e3", "e4", "e5"]) {
      await entry(id, "b", T(10))
    }
    const scope = { feedId: "b", limit: 2 }
    const ids = (page: { entries: { id: string }[] }) =>
      page.entries.map((e) => e.id)
    const first = await listEntries("u1", scope)
    expect(first.prevCursor).toBeNull()
    const second = await listEntries("u1", {
      ...scope,
      cursor: first.nextCursor!,
    })
    const third = await listEntries("u1", {
      ...scope,
      cursor: second.nextCursor!,
    })
    expect([ids(first), ids(second), ids(third)]).toEqual([
      ["e5", "e4"],
      ["e3", "e2"],
      ["e1", "b1"],
    ])
    expect(third.nextCursor).toBeNull()

    const backToSecond = await listEntries("u1", {
      ...scope,
      before: third.prevCursor!,
    })
    expect(ids(backToSecond)).toEqual(["e3", "e2"])
    expect(backToSecond.nextCursor).toBe(second.nextCursor)
    expect(backToSecond.prevCursor).not.toBeNull()

    // A page or less above is the first page, not a short one.
    const backToFirst = await listEntries("u1", {
      ...scope,
      before: backToSecond.prevCursor!,
    })
    expect(ids(backToFirst)).toEqual(["e5", "e4"])
    expect(backToFirst.prevCursor).toBeNull()
    expect(backToFirst.nextCursor).toBe(first.nextCursor)

    // before wins over cursor.
    const both = await listEntries("u1", {
      ...scope,
      cursor: first.nextCursor!,
      before: third.prevCursor!,
    })
    expect(ids(both)).toEqual(["e3", "e2"])
  })

  test("an empty page past the end steps back up from its cursor", async () => {
    const scope = { feedId: "a", unreadOnly: true }
    const first = await listEntries("u1", { ...scope, limit: 1 })
    expect(first.entries.map((e) => e.id)).toEqual(["a2"])
    // The only older unread entry is read before the person pages on.
    await read("u1", "a1")
    const past = await listEntries("u1", {
      ...scope,
      limit: 1,
      cursor: first.nextCursor!,
    })
    expect(past.entries).toEqual([])
    expect(past.prevCursor).toBe(first.nextCursor)
    const back = await listEntries("u1", {
      ...scope,
      limit: 1,
      before: past.prevCursor!,
    })
    expect(back.entries.map((e) => e.id)).toEqual(["a2"])
    expect(back.prevCursor).toBeNull()
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
    expect(await code(listEntries("u1", { before: "garbage" }))).toBe(
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

  test("pageCursor lists a page that starts at the entry", async () => {
    const { pageCursor } = await getEntryNavigation("u1", "a2")
    const page = await listEntries("u1", { cursor: pageCursor! })
    expect(page.entries[0].id).toBe("a2")
    // The newest entry's page is the first page.
    expect(
      (await getEntryNavigation("u1", "a2", { feedId: "a" })).pageCursor
    ).toBeNull()
  })

  test("another user's entry or feed is not_found", async () => {
    expect(await code(getNeighbours("u1", "c1"))).toBe("not_found")
    expect(await code(getNeighbours("u1", "a1", { feedId: "c" }))).toBe(
      "not_found"
    )
  })

  test("an entry outside the requested feed is not_found", async () => {
    expect(await code(getNeighbours("u1", "a1", { feedId: "b" }))).toBe(
      "not_found"
    )
  })
})

describe("markRead / markUnread", () => {
  test("idempotent both ways, per user", async () => {
    await markRead("u1", "a1")
    await markRead("u1", "a1")
    expect(await db.readMark.count({ where: { userId: "u1" } })).toBe(1)
    expect((await getEntry("u2", "a1")).read).toBe(false)
    await markUnread("u1", "a1")
    await markUnread("u1", "a1")
    expect(await db.readMark.count()).toBe(0)
  })

  test("unknown, pruned or not-followed entries are not_found", async () => {
    expect(await code(markRead("u1", "missing"))).toBe("not_found")
    expect(await code(markRead("u1", "c1"))).toBe("not_found")
    expect(await code(markUnread("u1", "c1"))).toBe("not_found")
    await db.entry.delete({ where: { id: "a1" } })
    expect(await code(markRead("u1", "a1"))).toBe("not_found")
  })
})

describe("markAllRead", () => {
  test("marks only the user's entries first seen up to upTo", async () => {
    await db.entry.update({ where: { id: "a1" }, data: { createdAt: T(1) } })
    await db.entry.update({ where: { id: "a2" }, data: { createdAt: T(2) } })
    await db.entry.update({ where: { id: "b1" }, data: { createdAt: T(3) } })
    await read("u1", "a1")
    expect(await markAllRead("u1", { upTo: T(2) })).toEqual({ marked: 1 })
    expect(
      (await listEntries("u1")).entries.map((e) => [e.id, e.read])
    ).toEqual([
      ["b1", false],
      ["a2", true],
      ["a1", true],
    ])
    expect(await db.readMark.count({ where: { userId: "u2" } })).toBe(0)
  })

  test("scoped to one feed", async () => {
    expect(await markAllRead("u1", { feedId: "b", upTo: new Date() })).toEqual({
      marked: 1,
    })
    const marks = await db.readMark.findMany({ select: { entryId: true } })
    expect(marks).toEqual([{ entryId: "b1" }])
  })

  test("a feed the user does not follow is not_found", async () => {
    expect(
      await code(markAllRead("u1", { feedId: "c", upTo: new Date() }))
    ).toBe("not_found")
    expect(await db.readMark.count()).toBe(0)
  })
})

describe("unsubscribe", () => {
  test("a shared feed stays for its other subscriber", async () => {
    await read("u1", "a1")
    await unsubscribe("u1", "a")
    expect(await db.feed.count({ where: { id: "a" } })).toBe(1)
    expect((await listSubscriptions("u1")).map((s) => s.feed.id)).toEqual(["b"])
  })

  test("the last subscriber deletes the feed, its entries and read marks", async () => {
    await read("u1", "b1")
    await unsubscribe("u1", "b")
    expect(await db.feed.count({ where: { id: "b" } })).toBe(0)
    expect(await db.entry.count({ where: { feedId: "b" } })).toBe(0)
    expect(await db.readMark.count()).toBe(0)
  })

  test("another user's or an unknown feed is not_found and deletes nothing", async () => {
    expect(await code(unsubscribe("u1", "c"))).toBe("not_found")
    expect(await code(unsubscribe("u1", "nope"))).toBe("not_found")
    expect(await db.feed.count({ where: { id: "c" } })).toBe(1)
  })
})

describe("subscribe", () => {
  test("an existing feed: subscribes without a fetch, then reports existed", async () => {
    const url = "https://c.example.com/feed.xml"
    expect(await subscribe("u1", { url })).toEqual({
      ok: true,
      feedId: "c",
      existed: false,
    })
    expect(await subscribe("u1", { url: ` ${url}#top` })).toEqual({
      ok: true,
      feedId: "c",
      existed: true,
    })
    expect(await db.subscription.count({ where: { userId: "u1" } })).toBe(3)
  })

  test("not http(s) or not a URL → invalid_url", async () => {
    for (const url of [
      "ftp://c.example.com/feed.xml",
      "javascript:alert(1)",
      "nope",
    ]) {
      expect(await subscribe("u1", { url })).toEqual({
        ok: false,
        code: "invalid_url",
      })
    }
  })

  test("a URL with no Feed row is fetched; a failed fetch writes nothing", async () => {
    const urls: string[] = []
    const fetch: SafeFetch = async (url) => {
      urls.push(url)
      return {
        status: 404,
        url,
        headers: new Headers(),
        text: "",
        kind: "unknown",
      }
    }
    expect(
      await subscribe(
        "u1",
        { url: "https://new.example.com/feed.xml" },
        { fetch }
      )
    ).toEqual({ ok: false, code: "not_found" })
    expect(urls).toEqual(["https://new.example.com/feed.xml"])
    expect(await db.feed.count()).toBe(3)
  })

  test("at 500 subscriptions → limit", async () => {
    await db.feed.createMany({
      data: Array.from({ length: 498 }, (_, i) => ({
        id: `f${i}`,
        url: `https://f${i}.example.com/`,
      })),
    })
    await db.subscription.createMany({
      data: Array.from({ length: 498 }, (_, i) => ({
        userId: "u1",
        feedId: `f${i}`,
      })),
    })
    expect(
      await subscribe("u1", { url: "https://c.example.com/feed.xml" })
    ).toEqual({ ok: false, code: "limit" })
    expect(await db.subscription.count({ where: { userId: "u1" } })).toBe(500)
  })
})

// Races are made deterministic by holding a row lock in a separate
// transaction, starting the racers in a chosen order, and waiting until each
// is blocked on a lock before starting the next and releasing.
async function holdLock(lock: (tx: typeof db) => Promise<unknown>) {
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let held!: () => void
  const isHeld = new Promise<void>((resolve) => (held = resolve))
  const done = db.$transaction(
    async (tx) => {
      await lock(tx as typeof db)
      held()
      await released
    },
    { timeout: 10_000 }
  )
  await isHeld
  return async () => {
    release()
    await done
  }
}

async function lockWaiters(n: number) {
  const deadline = Date.now() + 3_000
  for (;;) {
    const [{ count }] = await db.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if (count >= n) return
    if (Date.now() > deadline) throw new Error(`never saw ${n} lock waiters`)
    await Bun.sleep(10)
  }
}

const lockFeed = (id: string) => (tx: typeof db) =>
  tx.$queryRaw`SELECT id FROM "Feed" WHERE id = ${id} FOR UPDATE`

describe("races", () => {
  test("two adds at 499 subscriptions leave exactly 500", async () => {
    await db.feed.createMany({
      data: Array.from({ length: 497 }, (_, i) => ({
        id: `f${i}`,
        url: `https://f${i}.example.com/`,
      })),
    })
    await db.subscription.createMany({
      data: Array.from({ length: 497 }, (_, i) => ({
        userId: "u1",
        feedId: `f${i}`,
      })),
    })
    await feed("d", "Delta", [])
    const release = await holdLock(
      (tx) => tx.$queryRaw`SELECT id FROM "user" WHERE id = 'u1' FOR UPDATE`
    )
    const first = subscribe("u1", { url: "https://c.example.com/feed.xml" })
    await lockWaiters(1)
    const second = subscribe("u1", { url: "https://d.example.com/feed.xml" })
    await lockWaiters(2)
    await release()
    const results = await Promise.all([first, second])
    expect(results.map((r) => r.ok).sort()).toEqual([false, true])
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, code: "limit" })
    expect(await db.subscription.count({ where: { userId: "u1" } })).toBe(500)
  })

  test("the last two subscribers leaving at once delete the feed", async () => {
    const release = await holdLock(lockFeed("a"))
    const first = unsubscribe("u1", "a")
    await lockWaiters(1)
    const second = unsubscribe("u2", "a")
    await lockWaiters(2)
    await release()
    await Promise.all([first, second])
    expect(await db.feed.count({ where: { id: "a" } })).toBe(0)
    expect(await db.entry.count({ where: { feedId: "a" } })).toBe(0)
  })

  test("subscribe before the last unsubscribe: the feed stays", async () => {
    const release = await holdLock(lockFeed("b"))
    const sub = subscribe("u2", { url: "https://b.example.com/feed.xml" })
    await lockWaiters(1)
    const unsub = unsubscribe("u1", "b")
    await lockWaiters(2)
    await release()
    expect(await sub).toEqual({ ok: true, feedId: "b", existed: false })
    await unsub
    expect(
      await db.subscription.findMany({
        where: { feedId: "b" },
        select: { userId: true },
      })
    ).toEqual([{ userId: "u2" }])
  })

  test("the last unsubscribe before subscribe: the feed is new again", async () => {
    const release = await holdLock(lockFeed("b"))
    const unsub = unsubscribe("u1", "b")
    await lockWaiters(1)
    // The feed is gone by the time subscribe sees it, so it is fetched as new.
    const fetch: SafeFetch = async (url) => ({
      status: 200,
      url,
      headers: new Headers(),
      text: '<?xml version="1.0"?><rss version="2.0"><channel><title>Beta</title></channel></rss>',
      kind: "xml",
    })
    const sub = subscribe(
      "u2",
      { url: "https://b.example.com/feed.xml" },
      { fetch }
    )
    await lockWaiters(2)
    await release()
    await unsub
    const result = await sub
    expect(result).toMatchObject({ ok: true, existed: false })
    expect(result.ok && result.feedId).not.toBe("b")
    expect(await db.feed.count({ where: { id: "b" } })).toBe(0)
    expect(
      await db.subscription.findMany({
        where: { feed: { url: "https://b.example.com/feed.xml" } },
        select: { userId: true },
      })
    ).toEqual([{ userId: "u2" }])
  })
})
