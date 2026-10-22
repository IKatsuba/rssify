import type { z } from "zod"

import { type Actor, apiError, requireApiKey } from "@/lib/actor"
import * as reader from "@/lib/reader"
import {
  readerErrorBody,
  subscribeErrorBody,
  subscriptionOf,
} from "@/lib/reader-output"
import {
  getEntryInput,
  listEntriesInput,
  markAllReadInput,
  markReadInput,
  markUnreadInput,
  subscribeInput,
  unsubscribeInput,
} from "@/lib/reader-schemas"

// /api/v1 (design §5.3): the Route Handlers only bind these to their paths.
// Each checks the x-api-key first, parses with the schemas the actions use
// and maps lib/reader.ts results to statuses.

class BadInput extends Error {}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) throw new BadInput(result.error.message)
  return result.data
}

async function jsonBody(request: Request) {
  try {
    return await request.json()
  } catch {
    throw new BadInput("Expected a JSON body")
  }
}

// Anything not the caller's is 404, never 403, so ids reveal nothing.
async function handle(
  request: Request,
  action: (actor: Actor) => Promise<Response>
) {
  const actor = await requireApiKey(request.headers)
  if (actor instanceof Response) return actor
  try {
    return await action(actor)
  } catch (e) {
    if (e instanceof BadInput) {
      return apiError(400, "invalid_input", e.message)
    }
    if (e instanceof reader.ReaderError) {
      const { code, message } = readerErrorBody(e)
      return apiError(code === "invalid_input" ? 400 : 404, code, message)
    }
    throw e
  }
}

const noContent = () => new Response(null, { status: 204 })

export function listSubscriptions(request: Request) {
  return handle(request, async ({ userId }) =>
    Response.json({ subscriptions: await reader.listSubscriptions(userId) })
  )
}

// options is the test seam reader.subscribe has; the route passes nothing.
export function subscribe(request: Request, options?: reader.SubscribeOptions) {
  return handle(request, async ({ userId }) => {
    const input = parse(subscribeInput, await jsonBody(request))
    const result = await reader.subscribe(userId, input, options)
    if (!result.ok) {
      return Response.json(
        { error: subscribeErrorBody(result, input) },
        { status: 422 }
      )
    }
    const subscription = await subscriptionOf(userId, result.feedId)
    return Response.json(
      { subscription },
      { status: result.existed ? 200 : 201 }
    )
  })
}

export function unsubscribe(request: Request, feedId: string) {
  return handle(request, async ({ userId }) => {
    await reader.unsubscribe(userId, parse(unsubscribeInput, { feedId }).feedId)
    return noContent()
  })
}

// Query strings carry text; only the exact spellings below are accepted, so
// a typo is a 400 rather than a silently different list.
function listQuery(url: URL) {
  const query = url.searchParams
  const unread = query.get("unread")
  const limit = query.get("limit")
  if (unread !== null && unread !== "true" && unread !== "false") {
    throw new BadInput("unread must be true or false")
  }
  if (limit !== null && !/^\d+$/.test(limit)) {
    throw new BadInput("limit must be a whole number")
  }
  return {
    feedId: query.get("feedId") ?? undefined,
    unreadOnly: unread === "true",
    limit: limit === null ? undefined : Number(limit),
    cursor: query.get("cursor") ?? undefined,
  }
}

export function listEntries(request: Request) {
  return handle(request, async ({ userId }) => {
    const input = parse(listEntriesInput, listQuery(new URL(request.url)))
    const { entries, nextCursor, asOf } = await reader.listEntries(
      userId,
      input
    )
    return Response.json({ entries, nextCursor, asOf })
  })
}

// Reading an entry here never marks it read (design §5.4).
export function getEntry(request: Request, entryId: string) {
  return handle(request, async ({ userId }) => {
    const input = parse(getEntryInput, { entryId })
    return Response.json({
      entry: await reader.getEntry(userId, input.entryId),
    })
  })
}

export function markRead(request: Request, entryId: string) {
  return handle(request, async ({ userId }) => {
    await reader.markRead(userId, parse(markReadInput, { entryId }).entryId)
    return noContent()
  })
}

export function markUnread(request: Request, entryId: string) {
  return handle(request, async ({ userId }) => {
    await reader.markUnread(userId, parse(markUnreadInput, { entryId }).entryId)
    return noContent()
  })
}

export function markAllRead(request: Request) {
  return handle(request, async ({ userId }) => {
    const input = parse(markAllReadInput, await jsonBody(request))
    return Response.json(await reader.markAllRead(userId, input))
  })
}
