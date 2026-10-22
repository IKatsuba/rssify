import { db } from "@/lib/db"
import { Prisma } from "@/lib/generated/prisma/client"
import { fetchForAdd, type AddOptions, type NewFeed } from "@/lib/ingest/add"
import { storeEntries, successFields } from "@/lib/ingest/refresh"
import { builtinSource } from "@/sources/builtin"

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
    .map((subscription) => ({
      ...subscription,
      unreadCount: counts.get(subscription.feed.id) ?? 0,
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

// cursor pages older than a position (nextCursor), before pages newer
// (prevCursor), so a list can step both ways; before wins if both are given.
export async function listEntries(
  userId: string,
  {
    limit = 50,
    cursor,
    before,
    ...scope
  }: EntryScope & { limit?: number; cursor?: string; before?: string } = {}
) {
  // asOf is taken before the read so markAllRead({ upTo: asOf }) never
  // touches an entry that arrived after this list was produced.
  const asOf = new Date()
  const take = Math.min(Math.max(Math.trunc(limit), 1), 100)
  const where = await scopeWhere(userId, scope)
  if (before !== undefined) {
    const newer = await db.entry.findMany({
      where: { AND: [where, newerThan(decodeCursor(before))] },
      orderBy: [{ sortAt: "asc" }, { id: "asc" }],
      take: take + 1,
      select: entrySelect(userId),
    })
    // With a page or less above, the answer is the first page itself, so
    // stepping back up lands on the same pages as stepping down did.
    if (newer.length > take) {
      const page = newer.slice(0, take).reverse()
      const last = page[take - 1]
      const older = await db.entry.findFirst({
        where: { AND: [where, olderThan(last)] },
        select: { id: true },
      })
      return {
        entries: page.map(toListEntry),
        nextCursor: older ? encodeCursor(last) : null,
        prevCursor: encodeCursor(page[0]),
        asOf,
      }
    }
    cursor = undefined
  }
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
    // Past the first page there is something above; an empty page past the
    // end steps back up from its own cursor.
    prevCursor: cursor ? (page[0] ? encodeCursor(page[0]) : cursor) : null,
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
  const { previousId, nextId } = await getEntryNavigation(
    userId,
    entryId,
    scope
  )
  return { previousId, nextId }
}

// The neighbours, plus pageCursor: the listEntries cursor of the page that
// starts at this entry (older than the one above it; null for the first
// page), so Back can land on its row after j/k left the page it came from.
export async function getEntryNavigation(
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
      select: { id: true, sortAt: true },
    }),
    db.entry.findFirst({
      where: { AND: [where, olderThan(anchor)] },
      orderBy: [{ sortAt: "desc" }, { id: "desc" }],
      select: { id: true },
    }),
  ])
  return {
    previousId: newer?.id ?? null,
    nextId: older?.id ?? null,
    pageCursor: newer ? encodeCursor(newer) : null,
  }
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
// Unsubscribe locks only the feed row; subscribe locks the user row, then
// the feed row, so there is no lock cycle. The feed lock
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

export type SubscribeInput = { url: string } | { source: string }

// Test seam, like refreshFeed's: production passes nothing.
export type SubscribeOptions = AddOptions & { now?: Date }

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

type Target = { url: string } | { code: "invalid_url" | "not_found" }

function resolveTarget(input: SubscribeInput): Target {
  if ("source" in input) {
    const source = builtinSource(input.source)
    if (!source) return { code: "not_found" }
    input = { url: source.url }
  }
  const url = normaliseUrl(input.url)
  return url ? { url } : { code: "invalid_url" }
}

// Subscribes to a feed that is already stored; null when there is none.
// The cap comes first, so a full account hears limit whatever it sends.
async function subscribeKnown(
  userId: string,
  target: Target
): Promise<SubscribeResult | null> {
  return db.$transaction(async (tx): Promise<SubscribeResult | null> => {
    // The user lock makes the cap count and the insert one step per user.
    await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`
    const count = await tx.subscription.count({ where: { userId } })
    if (count >= SUBSCRIPTION_LIMIT) return { ok: false, code: "limit" }
    if ("code" in target) return { ok: false, code: target.code }
    // A feed deleted by a last unsubscribe while we waited for its lock
    // is skipped by FOR UPDATE, so it reads as not existing.
    const [feed] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Feed" WHERE url = ${target.url} FOR UPDATE`
    if (!feed) return null
    // A known feed is polled on its own schedule, so subscribing never
    // fetches.
    const { count: created } = await tx.subscription.createMany({
      data: { userId, feedId: feed.id },
      skipDuplicates: true,
    })
    return { ok: true, feedId: feed.id, existed: created === 0 }
  })
}

// The first fetch happens outside any transaction; only its result is
// written, all at once, so a failure leaves nothing behind.
async function storeNewFeed(
  userId: string,
  url: string,
  feed: NewFeed,
  now: Date
): Promise<SubscribeResult> {
  const { entries, ...fields } = feed
  return db.$transaction(async (tx): Promise<SubscribeResult> => {
    await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`
    const count = await tx.subscription.count({ where: { userId } })
    if (count >= SUBSCRIPTION_LIMIT) return { ok: false, code: "limit" }
    let feedId: string | undefined
    // Two people adding one new URL at once: ON CONFLICT makes the second
    // wait for the first and then subscribe to its row, whose entries the
    // first stored. The retry covers that row being unsubscribed away
    // between the two statements.
    for (let attempt = 0; !feedId && attempt < 2; attempt++) {
      const [created] = await tx.feed.createManyAndReturn({
        data: { url, ...fields, ...successFields(now) },
        skipDuplicates: true,
        select: { id: true },
      })
      if (created) {
        feedId = created.id
        await storeEntries(tx, feedId, entries, now)
        break
      }
      const [existing] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Feed" WHERE url = ${url} FOR UPDATE`
      feedId = existing?.id
    }
    if (!feedId) throw new Error(`Could not store or find the feed ${url}`)
    const { count: subscribed } = await tx.subscription.createMany({
      data: { userId, feedId },
      skipDuplicates: true,
    })
    return { ok: true, feedId, existed: subscribed === 0 }
  })
}

export async function subscribe(
  userId: string,
  input: SubscribeInput,
  { now = new Date(), ...options }: SubscribeOptions = {}
): Promise<SubscribeResult> {
  const target = resolveTarget(input)
  const known = await subscribeKnown(userId, target)
  if (known) return known
  // subscribeKnown answers every non-URL target, so this is a URL.
  let url = (target as { url: string }).url

  let fetched = await fetchForAdd(url, options)
  if (fetched.kind === "page") {
    const feeds = [
      ...new Set(fetched.feeds.flatMap((feed) => normaliseUrl(feed) ?? [])),
    ]
    if (feeds.length === 0) return { ok: false, code: "not_found" }
    if (feeds.length > 1) return { ok: false, code: "multiple", choices: feeds }
    // Discovery stores the URL it found, which may already be a feed here.
    url = feeds[0]
    const again = await subscribeKnown(userId, { url })
    if (again) return again
    fetched = await fetchForAdd(url, options)
    // A page that points to another page is not followed further.
    if (fetched.kind === "page") return { ok: false, code: "not_found" }
  }
  if (fetched.kind === "error") return { ok: false, code: fetched.code }
  // A direct feed keeps the address it was added by, even after redirects.
  return storeNewFeed(userId, url, fetched.feed, now)
}
