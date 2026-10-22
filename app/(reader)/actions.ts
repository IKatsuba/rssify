"use server"

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"
import type { z } from "zod"

import { requireUser } from "@/lib/actor"
import * as apiKeys from "@/lib/api-keys"
import { db } from "@/lib/db"
import * as reader from "@/lib/reader"
import {
  createApiKeyInput,
  markAllReadInput,
  markReadInput,
  markUnreadInput,
  revokeApiKeyInput,
  subscribeInput,
  unsubscribeInput,
} from "@/lib/reader-schemas"

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

// Inputs arrive from the network, so their types are not trusted: each is
// parsed inside run, after the session check. Junk throws a TypeError, as
// before the schemas, so the client treats it like any failed action.
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new TypeError(result.error.message)
  return result.data
}

export async function subscribe(input: { url: string } | { source: string }) {
  return run(async (userId) => {
    const result = await reader.subscribe(userId, parse(subscribeInput, input))
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
    await reader.unsubscribe(userId, parse(unsubscribeInput, { feedId }).feedId)
    return { ok: true as const }
  })
}

export async function markRead(entryId: string) {
  return run(async (userId) => {
    await reader.markRead(userId, parse(markReadInput, { entryId }).entryId)
    return { ok: true as const }
  })
}

export async function markUnread(entryId: string) {
  return run(async (userId) => {
    await reader.markUnread(userId, parse(markUnreadInput, { entryId }).entryId)
    return { ok: true as const }
  })
}

export async function markAllRead(input: {
  feedId?: string
  upTo: Date | string
}) {
  return run(async (userId) => {
    const { marked } = await reader.markAllRead(
      userId,
      parse(markAllReadInput, input)
    )
    return { ok: true as const, marked }
  })
}

// Keys are managed with the session only, never with a key (design §9).
export async function createApiKey(name: string) {
  await requireUser()
  const input = parse(createApiKeyInput, { name })
  const { key } = await apiKeys.createApiKey(await headers(), input.name)
  revalidatePath("/", "layout")
  return { key }
}

export async function revokeApiKey(keyId: string) {
  await requireUser()
  const input = parse(revokeApiKeyInput, { keyId })
  const result = await apiKeys.revokeApiKey(await headers(), input.keyId)
  if (result.ok) revalidatePath("/", "layout")
  return result
}
