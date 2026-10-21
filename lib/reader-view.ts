import { longAgo } from "@/lib/relative-time"

// What the reader pages read from the URL and show, kept out of the pages so
// tests can reach it.

export type ListFilter = "unread" | "all"

type SearchParams = Record<string, string | string[] | undefined>

// A repeated parameter is treated as missing rather than guessed at.
const one = (value: string | string[] | undefined) =>
  typeof value === "string" && value !== "" ? value : undefined

export function readListParams(params: SearchParams) {
  return {
    filter: (one(params.filter) === "all" ? "all" : "unread") as ListFilter,
    cursor: one(params.cursor),
    before: one(params.before),
  }
}

// Unread is the default, so it stays out of the URL.
export function listHref(
  path: string,
  {
    filter,
    cursor,
    before,
  }: { filter: ListFilter; cursor?: string; before?: string }
) {
  const query = new URLSearchParams()
  if (filter === "all") query.set("filter", "all")
  if (cursor) query.set("cursor", cursor)
  if (before) query.set("before", before)
  const search = query.toString()
  return search ? `${path}?${search}` : path
}

// The entry remembers the list it was opened from, for Back and ↑/↓.
export function entryHref(
  entryId: string,
  { feedId, filter }: { feedId?: string; filter: ListFilter }
) {
  const query = new URLSearchParams()
  if (feedId) query.set("feed", feedId)
  if (filter === "all") query.set("filter", "all")
  const search = query.toString()
  return `/entries/${entryId}${search ? `?${search}` : ""}`
}

export type EmptyState =
  | "no_feeds"
  | "caught_up"
  | "nothing_at_all"
  | "feed_no_unread"
  | "feed_no_entries"

// Which empty state a list with no rows shows; null while it has rows or is
// past its first page (the paging links say enough there).
export function emptyState({
  rows,
  paged,
  feedId,
  filter,
  subscriptions,
  feedHasEntries,
}: {
  rows: number
  paged: boolean
  feedId?: string
  filter: ListFilter
  subscriptions: number
  feedHasEntries?: boolean
}): EmptyState | null {
  if (rows > 0 || paged) return null
  if (!feedId) {
    if (subscriptions === 0) return "no_feeds"
    return filter === "unread" ? "caught_up" : "nothing_at_all"
  }
  return filter === "unread" && feedHasEntries
    ? "feed_no_unread"
    : "feed_no_entries"
}

export type FeedNotice = { title: string; description: string }

export function feedNotice(
  feed: {
    status: "ok" | "failing" | "gone"
    lastError: string | null
    lastSuccessAt: Date | null
  },
  now = new Date()
): FeedNotice | null {
  if (feed.status === "gone") {
    return {
      title: "This feed has stopped",
      description:
        "The site says this feed is gone, so we no longer check it. Its entries stay until you unsubscribe.",
    }
  }
  if (feed.status !== "failing") return null
  const when = feed.lastSuccessAt
    ? `Last updated ${longAgo(feed.lastSuccessAt, now)}.`
    : "We haven’t been able to fetch it yet."
  const why = feed.lastError ? ` The last try failed: ${feed.lastError}.` : ""
  return {
    title: "This feed isn’t updating",
    description: `${when}${why} We’ll keep trying.`,
  }
}
