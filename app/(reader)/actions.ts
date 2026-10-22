"use server"

import { revalidatePath } from "next/cache"

import { requireUser } from "@/lib/actor"
import { db } from "@/lib/db"
import * as reader from "@/lib/reader"

type NotFound = { ok: false; code: "not_found" }

// Ownership is decided in lib/reader.ts from the session's userId; a
// ReaderError there means the caller cannot see the thing, and anything
// else (a database error) is thrown so the client shows its "Couldn’t …".
async function run<T>(
  action: (userId: string) => Promise<T>
): Promise<T | NotFound> {
  const { userId } = await requireUser()
  let result: T
  try {
    result = await action(userId)
  } catch (e) {
    if (e instanceof reader.ReaderError) return { ok: false, code: "not_found" }
    throw e
  }
  revalidatePath("/", "layout")
  return result
}

// Inputs arrive from the network, so their types are not trusted. Full
// schemas come with the API; this only keeps junk away from Prisma.
function id(value: unknown) {
  if (typeof value !== "string" || value === "") {
    throw new TypeError("Expected an id")
  }
  return value
}

export async function subscribe(input: { url: string } | { source: string }) {
  const target =
    input && typeof input === "object" && "source" in input
      ? { source: String(input.source) }
      : { url: String((input as { url?: unknown })?.url ?? "") }
  return run(async (userId) => {
    const result = await reader.subscribe(userId, target)
    if (!result.ok) return result
    // The toasts name the feed; a feed without a title goes by its URL.
    const feed = await db.feed.findUniqueOrThrow({
      where: { id: result.feedId },
      select: { title: true, url: true },
    })
    return { ...result, title: feed.title ?? feed.url }
  })
}

export async function unsubscribe(feedId: string) {
  return run(async (userId) => {
    await reader.unsubscribe(userId, id(feedId))
    return { ok: true as const }
  })
}

export async function markRead(entryId: string) {
  return run(async (userId) => {
    await reader.markRead(userId, id(entryId))
    return { ok: true as const }
  })
}

export async function markUnread(entryId: string) {
  return run(async (userId) => {
    await reader.markUnread(userId, id(entryId))
    return { ok: true as const }
  })
}

export async function markAllRead({
  feedId,
  upTo,
}: {
  feedId?: string
  upTo: Date | string
}) {
  return run(async (userId) => {
    const cutoff = new Date(upTo)
    if (Number.isNaN(cutoff.getTime())) throw new TypeError("Expected upTo")
    const { marked } = await reader.markAllRead(userId, {
      feedId: feedId === undefined ? undefined : id(feedId),
      upTo: cutoff,
    })
    return { ok: true as const, marked }
  })
}
