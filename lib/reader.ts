import { db } from "@/lib/db"
import type { Prisma } from "@/lib/generated/prisma/client"

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
  const anchor = await db.entry.findFirst({
    where: { id: entryId, feed: { subscriptions: { some: { userId } } } },
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
