import { STATUS_CODES } from "node:http"

import { db } from "@/lib/db"
import type { FeedStatus } from "@/lib/generated/prisma/client"

import { FeedParseError, parseFeed } from "./parse"
import { safeFetch, SafeFetchError, type SafeFetch } from "./safe-fetch"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const INTERVAL = HOUR
const MAX_DELAY = 24 * HOUR
const FETCH_TIMEOUT = 15_000
const FAILING_AFTER = 3
const TAKE_PER_FETCH = 100
const KEEP_PER_FEED = 500

export type RefreshOutcome =
  | { outcome: "missing" }
  | { outcome: "skipped" }
  | { outcome: "ok"; stored: number }
  | { outcome: "not_modified" }
  | { outcome: "gone" }
  | { outcome: "failed"; error: string }

export type RefreshOptions = {
  skipIfFreshWithin?: number
  fetch?: SafeFetch
  now?: Date
}

export const LAST_ERROR = {
  timeout: "the site didn’t answer in time",
  notFound: "the address couldn’t be found",
  notAFeed: "the response wasn’t a feed",
  tooLarge: "the feed is over 10 MB",
  notAllowed: "the address isn’t allowed",
}

export function answeredError(status: number): string {
  const reason = STATUS_CODES[status]
  return `the site answered ${status}${reason ? ` ${reason}` : ""}`
}

// safe-fetch reports a timeout and a DNS failure alike as unreachable;
// only our own deadline tells them apart.
export function fetchErrorText(error: SafeFetchError, timedOut: boolean) {
  switch (error.code) {
    case "invalid_url":
    case "blocked":
      return LAST_ERROR.notAllowed
    case "too_large":
      return LAST_ERROR.tooLarge
    case "unreachable":
      return timedOut ? LAST_ERROR.timeout : LAST_ERROR.notFound
  }
}

export function backoff(failureCount: number): number {
  return Math.min(HOUR * 2 ** failureCount, MAX_DELAY)
}

// Retry-After is either delay-seconds or an HTTP-date (RFC 9110 §10.2.3).
export function retryAfterMs(value: string | null, now: Date): number | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const date = Date.parse(trimmed)
  return Number.isNaN(date) ? null : Math.max(date - now.getTime(), 0)
}

export async function refreshFeed(
  feedId: string,
  {
    skipIfFreshWithin,
    fetch = safeFetch,
    now = new Date(),
  }: RefreshOptions = {}
): Promise<RefreshOutcome> {
  const feed = await db.feed.findUnique({ where: { id: feedId } })
  if (!feed) return { outcome: "missing" }

  // A duplicate queue delivery arrives right after the first one wrote.
  if (
    skipIfFreshWithin !== undefined &&
    feed.lastFetchedAt &&
    now.getTime() - feed.lastFetchedAt.getTime() < skipIfFreshWithin * 1000
  ) {
    return { outcome: "skipped" }
  }

  // Stub until the cursor-blog plugin unit (RSSF-9) replaces it with the
  // plugin run; until then a plugin feed must not be fetched as a feed URL.
  if (feed.pluginId) {
    throw new Error(`Source plugins are not supported yet: ${feed.pluginId}`)
  }

  const fail = async (error: string, retryAfter: number | null = null) => {
    const failureCount = feed.failureCount + 1
    const delay = Math.min(
      Math.max(backoff(failureCount), retryAfter ?? 0),
      MAX_DELAY
    )
    const status: FeedStatus =
      failureCount >= FAILING_AFTER ? "failing" : feed.status
    await db.feed.update({
      where: { id: feed.id },
      data: {
        lastFetchedAt: now,
        nextFetchAt: new Date(now.getTime() + delay),
        failureCount,
        status,
        lastError: error,
      },
    })
    return { outcome: "failed", error } as const
  }

  const deadline = AbortSignal.timeout(FETCH_TIMEOUT)
  let response
  try {
    response = await fetch(feed.url, {
      etag: feed.etag,
      lastModified: feed.lastModified,
      deadline,
    })
  } catch (error) {
    if (!(error instanceof SafeFetchError)) throw error
    return fail(fetchErrorText(error, deadline.aborted))
  }

  const success = {
    lastFetchedAt: now,
    lastSuccessAt: now,
    nextFetchAt: new Date(now.getTime() + INTERVAL),
    failureCount: 0,
    status: "ok" as const,
    lastError: null,
  }

  if (response.status === 304) {
    await db.feed.update({
      where: { id: feed.id },
      data: {
        ...success,
        etag: response.headers.get("etag") ?? feed.etag,
        lastModified:
          response.headers.get("last-modified") ?? feed.lastModified,
      },
    })
    return { outcome: "not_modified" }
  }

  if (response.status === 410) {
    await db.feed.update({
      where: { id: feed.id },
      data: { lastFetchedAt: now, nextFetchAt: null, status: "gone" },
    })
    return { outcome: "gone" }
  }

  if (response.status < 200 || response.status >= 300) {
    const retryAfter =
      response.status === 429 || response.status === 503
        ? retryAfterMs(response.headers.get("retry-after"), now)
        : null
    return fail(answeredError(response.status), retryAfter)
  }

  let parsed
  try {
    parsed = parseFeed(response.text, feed.url)
  } catch (error) {
    if (!(error instanceof FeedParseError)) throw error
    return fail(LAST_ERROR.notAFeed)
  }

  // Undated and future-dated entries sort as "now"; sort is stable, so
  // equal times keep document order.
  const ranked = parsed.entries
    .map((entry) => ({
      ...entry,
      sortAt: new Date(
        Math.min(entry.publishedAt?.getTime() ?? now.getTime(), now.getTime())
      ),
    }))
    .sort((a, b) => b.sortAt.getTime() - a.sortAt.getTime())
    .slice(0, TAKE_PER_FETCH)

  // One transaction, so a database error leaves lastFetchedAt unwritten
  // and the queue's redelivery is not skipped as a duplicate.
  const stored = await db.$transaction(async (tx) => {
    // skipDuplicates on (feedId, guid): the first version of an entry wins.
    const { count } = await tx.entry.createMany({
      data: ranked.map((entry) => ({
        ...entry,
        feedId: feed.id,
        createdAt: now,
      })),
      skipDuplicates: true,
    })
    await tx.$executeRaw`
      DELETE FROM "Entry" WHERE id IN (
        SELECT id FROM "Entry" WHERE "feedId" = ${feed.id}
        ORDER BY "sortAt" DESC, id DESC
        OFFSET ${KEEP_PER_FEED}
      )`
    await tx.feed.update({
      where: { id: feed.id },
      data: {
        ...success,
        title: parsed.title,
        siteUrl: parsed.siteUrl,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      },
    })
    return count
  })
  return { outcome: "ok", stored }
}
