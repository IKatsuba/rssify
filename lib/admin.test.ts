import { describe, expect, test } from "bun:test"

import { db } from "@/test/db"
import { mintMcpToken } from "@/test/mcp-token"

import { deleteUser, listFeeds, listUsers } from "./admin"
import { auth } from "./auth"

async function user(id: string, createdAt: string) {
  await db.user.create({
    data: { id, name: id, email: `${id}@example.com`, createdAt },
  })
}

async function feed(
  url: string,
  followers: string[],
  data: { status?: "ok" | "failing" | "gone"; lastError?: string } = {}
) {
  const { id } = await db.feed.create({
    data: {
      url,
      ...data,
      subscriptions: { create: followers.map((userId) => ({ userId })) },
      entries: {
        create: { guid: `${url}#1`, title: "One", sortAt: new Date() },
      },
    },
  })
  return id
}

describe("listUsers", () => {
  test("every user, oldest joined first, with subscription counts", async () => {
    await user("u2", "2026-02-01T00:00:00Z")
    await user("u1", "2026-01-01T00:00:00Z")
    await user("u3", "2026-03-01T00:00:00Z")
    await feed("https://a.example/feed", ["u1", "u2"])
    await feed("https://b.example/feed", ["u1"])
    expect((await listUsers()).map((u) => [u.id, u.email, u.feeds])).toEqual([
      ["u1", "u1@example.com", 2],
      ["u2", "u2@example.com", 1],
      ["u3", "u3@example.com", 0],
    ])
  })
})

describe("listFeeds", () => {
  test("failing first, then gone, then ok, each by URL", async () => {
    await user("u1", "2026-01-01T00:00:00Z")
    await user("u2", "2026-01-02T00:00:00Z")
    await feed("https://b.example/ok", ["u1"])
    await feed("https://a.example/ok", ["u1", "u2"])
    await feed("https://z.example/failing", ["u1"], {
      status: "failing",
      lastError: "the site didn’t answer in time",
    })
    await feed("https://c.example/gone", ["u2"], { status: "gone" })
    await feed("https://y.example/failing", ["u2"], { status: "failing" })
    const feeds = await listFeeds()
    expect(feeds.map((f) => [f.url, f.status, f.subscribers])).toEqual([
      ["https://y.example/failing", "failing", 1],
      ["https://z.example/failing", "failing", 1],
      ["https://c.example/gone", "gone", 1],
      ["https://a.example/ok", "ok", 2],
      ["https://b.example/ok", "ok", 1],
    ])
    expect(feeds[1]).toMatchObject({
      lastError: "the site didn’t answer in time",
      failureCount: 0,
      lastSuccessAt: null,
    })
  })
})

describe("deleteUser", () => {
  test("removes the user's rows and orphaned feeds, keeps shared feeds", async () => {
    // A real OAuth grant, so its consent and tokens are part of the user.
    await mintMcpToken("u2")
    await user("u1", "2026-01-01T00:00:00Z")
    const shared = await feed("https://shared.example/feed", ["u1", "u2"])
    const own = await feed("https://own.example/feed", ["u2"])
    const other = await feed("https://other.example/feed", ["u1"])
    const entries = await db.entry.findMany({ select: { id: true } })
    await db.readMark.createMany({
      data: entries.flatMap((e) => [
        { userId: "u1", entryId: e.id },
        { userId: "u2", entryId: e.id },
      ]),
    })
    await auth.api.createApiKey({ body: { userId: "u2" } })
    await auth.api.createApiKey({ body: { userId: "u1" } })

    await deleteUser("u1-admin", "u2")

    expect(await db.user.findMany({ select: { id: true } })).toEqual([
      { id: "u1" },
    ])
    const where = { where: { userId: "u2" } }
    expect(await db.session.count(where)).toBe(0)
    expect(await db.account.count(where)).toBe(0)
    expect(await db.oauthConsent.count(where)).toBe(0)
    expect(await db.oauthRefreshToken.count(where)).toBe(0)
    expect(await db.oauthAccessToken.count(where)).toBe(0)
    expect(await db.apikey.count({ where: { referenceId: "u2" } })).toBe(0)
    expect(await db.apikey.count({ where: { referenceId: "u1" } })).toBe(1)
    expect(await db.subscription.count({ where: { userId: "u2" } })).toBe(0)
    expect(await db.readMark.count({ where: { userId: "u2" } })).toBe(0)
    const feeds = await db.feed.findMany({ select: { id: true } })
    expect(feeds.map((f) => f.id).sort()).toEqual([shared, other].sort())
    expect(await db.entry.count({ where: { feedId: own } })).toBe(0)
    expect(await db.readMark.count({ where: { userId: "u1" } })).toBe(2)
  })

  test("waits for a subscribe holding the user, then deletes its feed too", async () => {
    await user("u2", "2026-01-01T00:00:00Z")
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let locked!: (pid: number) => void
    const lockTaken = new Promise<number>((resolve) => (locked = resolve))
    // Stands in for subscribe: it locks the user, then adds a feed.
    const subscribing = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "user" WHERE id = 'u2' FOR UPDATE`
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid`
      locked(pid)
      await held
      await tx.feed.create({
        data: {
          url: "https://new.example/feed",
          subscriptions: { create: { userId: "u2" } },
          entries: { create: { guid: "1", title: "One", sortAt: new Date() } },
        },
      })
    })
    const heldPid = await lockTaken
    const deleting = deleteUser("admin", "u2")
    try {
      // Release only once Postgres shows the delete blocked on the held
      // transaction, so the order the test claims is the order that ran.
      const deadline = Date.now() + 5000
      for (;;) {
        const [{ waiting }] = await db.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE ${heldPid}::int = ANY(pg_blocking_pids(pid))`
        if (waiting > 0) break
        if (Date.now() > deadline) throw new Error("deleteUser never blocked")
        await Bun.sleep(10)
      }
    } finally {
      release()
    }
    await subscribing
    await deleting
    expect(await db.user.count()).toBe(0)
    expect(await db.feed.count()).toBe(0)
    expect(await db.entry.count()).toBe(0)
  })

  test("refuses the actor's own id", async () => {
    await user("u1", "2026-01-01T00:00:00Z")
    expect(deleteUser("u1", "u1")).rejects.toThrow(TypeError)
    expect(await db.user.count()).toBe(1)
  })

  test("an unknown user is a no-op", async () => {
    await user("u1", "2026-01-01T00:00:00Z")
    await feed("https://a.example/feed", ["u1"])
    await deleteUser("admin", "nobody")
    expect(await db.user.count()).toBe(1)
    expect(await db.feed.count()).toBe(1)
  })
})
