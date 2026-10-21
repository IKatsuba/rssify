import { db } from "@/lib/db"
import { Prisma } from "@/lib/generated/prisma/client"

// Every function takes the caller's userId and derives ownership from it;
// anything not the caller's is not_found, never forbidden, so ids of other
// people's feeds and entries reveal nothing.
export class ReaderError extends Error {
  constructor(readonly code: "not_found" | "invalid_cursor") {
    super(code)
  }
}

export async function listSubscriptions(userId: string) {
  const [subscriptions, counts] = await Promise.all([
    db.subscription.findMany({
      where: { userId },
      select: {
        id: true,
        createdAt: true,
        feed: {
          select: {
            id: true,
            url: true,
            title: true,
            siteUrl: true,
            pluginId: true,
            status: true,
            lastError: true,
            lastSuccessAt: true,
          },
        },
      },
    }),
    unreadCounts(userId),
  ])
  return subscriptions
    .map(({ feed: { pluginId, ...feed }, ...subscription }) => ({
      ...subscription,
      unreadCount: counts.get(feed.id) ?? 0,
      // The API calls the stored plugin id sourceId; null for a plain feed.
      feed: { ...feed, sourceId: pluginId },
    }))
    .sort((a, b) =>
      (a.feed.title ?? a.feed.url).localeCompare(b.feed.title ?? b.feed.url)
    )
}

// One grouped anti-join over the user's feeds: no read mark = unread.
async function unreadCounts(userId: string) {
  const rows = await db.$queryRaw<{ feedId: string; count: number }[]>`
    SELECT e."feedId", count(*)::int AS count
    FROM "Entry" e
    JOIN "Subscription" s ON s."feedId" = e."feedId" AND s."userId" = ${userId}
    WHERE NOT EXISTS (
      SELECT 1 FROM "ReadMark" r
      WHERE r."userId" = ${userId} AND r."entryId" = e.id
    )
    GROUP BY e."feedId"`
  return new Map(rows.map((row) => [row.feedId, row.count]))
}

export type EntryScope = { feedId?: string; unreadOnly?: boolean }

type Position = { sortAt: Date; id: string }

// The cursor is the last row's keyset position, opaque to callers.
function encodeCursor({ sortAt, id }: Position) {
  return Buffer.from(`${sortAt.toISOString()} ${id}`).toString("base64url")
}

function decodeCursor(cursor: string): Position {
  const [iso, id] = Buffer.from(cursor, "base64url").toString().split(" ")
  const sortAt = new Date(iso)
  if (!id || Number.isNaN(sortAt.getTime())) {
    throw new ReaderError("invalid_cursor")
  }
  return { sortAt, id }
}

async function scopeWhere(
  userId: string,
  { feedId, unreadOnly = false }: EntryScope
): Promise<Prisma.EntryWhereInput> {
  if (feedId) {
    const subscribed = await db.subscription.findUnique({
      where: { userId_feedId: { userId, feedId } },
      select: { id: true },
    })
    if (!subscribed) throw new ReaderError("not_found")
  }
  return {
    feed: { subscriptions: { some: { userId } } },
    ...(feedId && { feedId }),
    ...(unreadOnly && { readMarks: { none: { userId } } }),
  }
}

// Strictly after a position in (sortAt desc, id desc) order, so entries
// sharing a sortAt are neither skipped nor repeated across pages.
const olderThan = ({ sortAt, id }: Position): Prisma.EntryWhereInput => ({
  OR: [{ sortAt: { lt: sortAt } }, { sortAt, id: { lt: id } }],
})

const newerThan = ({ sortAt, id }: Position): Prisma.EntryWhereInput => ({
  OR: [{ sortAt: { gt: sortAt } }, { sortAt, id: { gt: id } }],
})

const entrySelect = (userId: string) =>
  ({
    id: true,
    feedId: true,
    title: true,
    url: true,
    author: true,
    summary: true,
    publishedAt: true,
    sortAt: true,
    feed: { select: { title: true } },
    readMarks: { where: { userId }, select: { entryId: true } },
  }) satisfies Prisma.EntrySelect

function toListEntry<
  T extends {
    feed: { title: string | null }
    readMarks: { entryId: string }[]
  },
>({ feed, readMarks, ...entry }: T) {
  return { ...entry, feedTitle: feed.title, read: readMarks.length > 0 }
}

export async function listEntries(
  userId: string,
  {
    limit = 50,
    cursor,
    ...scope
  }: EntryScope & { limit?: number; cursor?: string } = {}
) {
  // asOf is taken before the read so markAllRead({ upTo: asOf }) never
  // touches an entry that arrived after this list was produced.
  const asOf = new Date()
  const take = Math.min(Math.max(Math.trunc(limit), 1), 100)
  const where = await scopeWhere(userId, scope)
  const rows = await db.entry.findMany({
    where: cursor ? { AND: [where, olderThan(decodeCursor(cursor))] } : where,
    orderBy: [{ sortAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: entrySelect(userId),
  })
  const page = rows.slice(0, take)
  return {
    entries: page.map(toListEntry),
    nextCursor: rows.length > take ? encodeCursor(page[take - 1]) : null,
    asOf,
  }
}

// Reading through here never marks read; the caller says so explicitly.
export async function getEntry(userId: string, entryId: string) {
  const entry = await db.entry.findFirst({
    where: { id: entryId, feed: { subscriptions: { some: { userId } } } },
    select: { ...entrySelect(userId), contentHtml: true },
  })
  if (!entry) throw new ReaderError("not_found")
  return toListEntry(entry)
}

// The entries above and below this one in the list it was opened from,
// anchored on its own (sortAt, id) so they hold even when it is now read
// and an unread-only list would no longer contain it.
export async function getNeighbours(
  userId: string,
  entryId: string,
  scope: EntryScope = {}
) {
  const where = await scopeWhere(userId, scope)
  // The anchor must be in the list's feed, but not under its unread filter.
  const anchor = await db.entry.findFirst({
    where: {
      id: entryId,
      feed: { subscriptions: { some: { userId } } },
      ...(scope.feedId && { feedId: scope.feedId }),
    },
    select: { sortAt: true, id: true },
  })
  if (!anchor) throw new ReaderError("not_found")
  const [newer, older] = await Promise.all([
    db.entry.findFirst({
      where: { AND: [where, newerThan(anchor)] },
      orderBy: [{ sortAt: "asc" }, { id: "asc" }],
      select: { id: true },
    }),
    db.entry.findFirst({
      where: { AND: [where, olderThan(anchor)] },
      orderBy: [{ sortAt: "desc" }, { id: "desc" }],
      select: { id: true },
    }),
  ])
  return { previousId: newer?.id ?? null, nextId: older?.id ?? null }
}

const visibleEntry = (userId: string, entryId: string) =>
  db.entry.findFirst({
    where: { id: entryId, feed: { subscriptions: { some: { userId } } } },
    select: { id: true },
  })

// Idempotent. An entry pruned between the check and the insert fails the
// foreign key, which is the same not_found as an unknown one.
export async function markRead(userId: string, entryId: string) {
  if (!(await visibleEntry(userId, entryId))) {
    throw new ReaderError("not_found")
  }
  try {
    await db.readMark.createMany({
      data: { userId, entryId },
      skipDuplicates: true,
    })
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2003"
    ) {
      throw new ReaderError("not_found")
    }
    throw e
  }
}

export async function markUnread(userId: string, entryId: string) {
  if (!(await visibleEntry(userId, entryId))) {
    throw new ReaderError("not_found")
  }
  await db.readMark.deleteMany({ where: { userId, entryId } })
}

// upTo is the list's asOf: entries first seen after the person looked stay
// unread. createdAt, not sortAt, because a late entry can carry an old date.
export async function markAllRead(
  userId: string,
  { feedId, upTo }: { feedId?: string; upTo: Date }
) {
  if (feedId) await scopeWhere(userId, { feedId })
  const marked = await db.$executeRaw`
    INSERT INTO "ReadMark" ("userId", "entryId")
    SELECT ${userId}, e.id
    FROM "Entry" e
    JOIN "Subscription" s ON s."feedId" = e."feedId" AND s."userId" = ${userId}
    WHERE e."createdAt" <= ${upTo}
      ${feedId ? Prisma.sql`AND e."feedId" = ${feedId}` : Prisma.empty}
    ON CONFLICT DO NOTHING`
  return { marked }
}

// The last subscriber takes the feed with it, cascading its entries and read
// marks, in the same transaction so no orphan feed is left to poll.
//
// Locks, always in this order: the user row, then the feed row. The feed lock
// serialises every subscribe and unsubscribe of one feed, so two last
// subscribers leaving at once cannot both see the other still there, and a
// subscribe never lands on a feed that is being deleted.
export async function unsubscribe(userId: string, feedId: string) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Feed" WHERE id = ${feedId} FOR UPDATE`
    const { count } = await tx.subscription.deleteMany({
      where: { userId, feedId },
    })
    if (count === 0) throw new ReaderError("not_found")
    await tx.$executeRaw`
      DELETE FROM "Feed" f
      WHERE f.id = ${feedId}
        AND NOT EXISTS (SELECT 1 FROM "Subscription" s WHERE s."feedId" = f.id)`
  })
}

export const SUBSCRIPTION_LIMIT = 500

export type SubscribeResult =
  | { ok: true; feedId: string; existed: boolean }
  | { ok: false; code: string; choices?: string[] }

// Minimal for now: a WHATWG parse, http(s) only, no fragment. The ingest
// unit owns any richer rule.
export function normaliseUrl(input: string) {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  url.hash = ""
  return url.href
}

// SEAM (build unit 6, "Add feed"): fetch, discovery and the new-feed
// transaction replace this, taking (userId, url). Until then a URL with no
// Feed row is refused with a code instead of being fetched.
async function subscribeNewFeed(): Promise<SubscribeResult> {
  return { ok: false, code: "not_supported" }
}

export async function subscribe(
  userId: string,
  { url: input }: { url: string }
): Promise<SubscribeResult> {
  const result = await db.$transaction(
    async (tx): Promise<SubscribeResult | null> => {
      // The user lock makes the cap count and the insert one step per user.
      await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`
      const count = await tx.subscription.count({ where: { userId } })
      if (count >= SUBSCRIPTION_LIMIT) return { ok: false, code: "limit" }
      const url = normaliseUrl(input)
      if (!url) return { ok: false, code: "invalid_url" }
      // A feed deleted by a last unsubscribe while we waited for its lock
      // is skipped by FOR UPDATE, so it reads as not existing.
      const [feed] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Feed" WHERE url = ${url} FOR UPDATE`
      if (!feed) return null
      // A known feed is polled on its own schedule, so subscribing never
      // fetches.
      const { count: created } = await tx.subscription.createMany({
        data: { userId, feedId: feed.id },
        skipDuplicates: true,
      })
      return { ok: true, feedId: feed.id, existed: created === 0 }
    }
  )
  return result ?? subscribeNewFeed()
}
