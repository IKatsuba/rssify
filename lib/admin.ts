import { db } from "@/lib/db"
import type { FeedStatus } from "@/lib/generated/prisma/client"

export type AdminUser = {
  id: string
  email: string
  createdAt: Date
  feeds: number
}

export type AdminFeed = {
  id: string
  url: string
  subscribers: number
  status: FeedStatus
  failureCount: number
  lastError: string | null
  lastSuccessAt: Date | null
}

export async function listUsers(): Promise<AdminUser[]> {
  const users = await db.user.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      email: true,
      createdAt: true,
      _count: { select: { subscriptions: true } },
    },
  })
  return users.map(({ _count, ...user }) => ({
    ...user,
    feeds: _count.subscriptions,
  }))
}

// Failing first, as the admin opens this page to find what is broken.
const STATUS_ORDER: Record<FeedStatus, number> = { failing: 0, gone: 1, ok: 2 }

export async function listFeeds(): Promise<AdminFeed[]> {
  const feeds = await db.feed.findMany({
    where: { subscriptions: { some: {} } },
    orderBy: { url: "asc" },
    select: {
      id: true,
      url: true,
      status: true,
      failureCount: true,
      lastError: true,
      lastSuccessAt: true,
      _count: { select: { subscriptions: true } },
    },
  })
  return feeds
    .map(({ _count, ...feed }) => ({
      ...feed,
      subscribers: _count.subscriptions,
    }))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
}

// Cascades remove the user's sessions, accounts, keys, subscriptions, read
// marks and OAuth rows; the feeds only they followed go too, as on a last
// unsubscribe. Locks go user, then feeds, the order subscribe takes them:
// a subscribe in flight finishes first, so the feed it adds is seen and
// deleted here, and the two cannot deadlock.
export async function deleteUser(actorId: string, userId: string) {
  if (actorId === userId) throw new TypeError("You can't delete yourself")
  await db.$transaction(async (tx) => {
    const user = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`
    if (user.length === 0) return
    const feeds = await tx.$queryRaw<{ id: string }[]>`
      SELECT f.id FROM "Feed" f
      JOIN "Subscription" s ON s."feedId" = f.id
      WHERE s."userId" = ${userId}
      ORDER BY f.id
      FOR UPDATE OF f`
    await tx.user.delete({ where: { id: userId } })
    if (feeds.length === 0) return
    await tx.feed.deleteMany({
      where: {
        id: { in: feeds.map((f) => f.id) },
        subscriptions: { none: {} },
      },
    })
  })
}
