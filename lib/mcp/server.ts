import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"

import * as reader from "@/lib/reader"
import {
  type ErrorBody,
  readerErrorBody,
  subscribeErrorBody,
  subscriptionOf,
  toJson,
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

// The MCP adapter (design §5.5): eight tools, each one lib/reader.ts call
// for the caller's userId, with the inputs the actions and /api/v1 parse
// and the bodies /api/v1 answers with.

// The /api/v1 JSON shapes, as outputSchema for structuredContent.
const time = z.iso.datetime()
const subscription = z.object({
  id: z.string(),
  createdAt: time,
  unreadCount: z.number().int(),
  feed: z.object({
    id: z.string(),
    url: z.string(),
    title: z.string().nullable(),
    siteUrl: z.string().nullable(),
    pluginId: z.string().nullable(),
    status: z.enum(["ok", "failing", "gone"]),
    lastError: z.string().nullable(),
    lastSuccessAt: time.nullable(),
  }),
})
const listEntry = z.object({
  id: z.string(),
  feedId: z.string(),
  feedTitle: z.string().nullable(),
  title: z.string(),
  url: z.string().nullable(),
  author: z.string().nullable(),
  summary: z.string().nullable(),
  publishedAt: time.nullable(),
  sortAt: time,
  read: z.boolean(),
})
const done = z.object({})

function ok(value: object) {
  const structuredContent = toJson(value) as Record<string, unknown>
  return {
    structuredContent,
    content: [
      { type: "text" as const, text: JSON.stringify(structuredContent) },
    ],
  }
}

function failed(body: ErrorBody) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
  }
}

type Result = ReturnType<typeof ok> | ReturnType<typeof failed>

// Others' data is not_found here as on the other two doors. Anything else is
// logged and answered with the reader's page-error sentence, never its own
// message: the SDK would echo it, and a database error says too much.
async function guarded(call: () => Promise<Result>) {
  try {
    return await call()
  } catch (e) {
    if (e instanceof reader.ReaderError) return failed(readerErrorBody(e))
    console.error("MCP tool failed", e)
    return failed({
      code: "internal_error",
      message: "Something went wrong on our side. Try again in a moment.",
    })
  }
}

const run = (call: () => Promise<object>) =>
  guarded(async () => ok(await call()))

// options is the test seam reader.subscribe has; the route passes nothing.
export function buildMcpServer(
  userId: string,
  options?: reader.SubscribeOptions
) {
  const server = new McpServer({ name: "rssify", version: "1.0.0" })

  server.registerTool(
    "list_feeds",
    {
      description: "List the feeds you follow, each with its unread count.",
      outputSchema: z.object({ subscriptions: z.array(subscription) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => ({
        subscriptions: await reader.listSubscriptions(userId),
      }))
  )

  server.registerTool(
    "subscribe",
    {
      description:
        "Follow a feed by its URL or a site's address (a GitHub Trending page works too), or a built-in source by id. If a site has several feeds, the error lists them as choices; call again with one.",
      inputSchema: subscribeInput,
      outputSchema: z.object({ subscription }),
      annotations: { openWorldHint: true, idempotentHint: true },
    },
    (input) =>
      guarded(async () => {
        const result = await reader.subscribe(userId, input, options)
        if (!result.ok) return failed(subscribeErrorBody(result, input))
        return ok({
          subscription: await subscriptionOf(userId, result.feedId),
        })
      })
  )

  server.registerTool(
    "unsubscribe",
    {
      description:
        "Stop following a feed. If you were its last subscriber, its entries are deleted.",
      inputSchema: unsubscribeInput,
      outputSchema: done,
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    ({ feedId }) =>
      run(async () => {
        await reader.unsubscribe(userId, feedId)
        return {}
      })
  )

  server.registerTool(
    "list_entries",
    {
      description:
        "List entries, newest first, from all feeds or one. Pass nextCursor back as cursor for older ones; asOf is the upTo for mark_all_read.",
      inputSchema: listEntriesInput,
      outputSchema: z.object({
        entries: z.array(listEntry),
        nextCursor: z.string().nullable(),
        asOf: time,
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) =>
      run(async () => {
        const { entries, nextCursor, asOf } = await reader.listEntries(
          userId,
          input
        )
        return { entries, nextCursor, asOf }
      })
  )

  // Reading an entry here never marks it read (design §5.4).
  server.registerTool(
    "get_entry",
    {
      description:
        "Get one entry with its sanitised HTML content. Does not mark it read.",
      inputSchema: getEntryInput,
      outputSchema: z.object({
        entry: listEntry.extend({ contentHtml: z.string().nullable() }),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ entryId }) =>
      run(async () => ({ entry: await reader.getEntry(userId, entryId) }))
  )

  server.registerTool(
    "mark_read",
    {
      description: "Mark one entry read.",
      inputSchema: markReadInput,
      outputSchema: done,
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    ({ entryId }) =>
      run(async () => {
        await reader.markRead(userId, entryId)
        return {}
      })
  )

  server.registerTool(
    "mark_unread",
    {
      description: "Mark one entry unread.",
      inputSchema: markUnreadInput,
      outputSchema: done,
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    ({ entryId }) =>
      run(async () => {
        await reader.markUnread(userId, entryId)
        return {}
      })
  )

  server.registerTool(
    "mark_all_read",
    {
      description:
        "Mark every entry read, in all feeds or one, that arrived by upTo (the asOf list_entries gave).",
      inputSchema: markAllReadInput,
      outputSchema: z.object({ marked: z.number().int() }),
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    (input) => run(() => reader.markAllRead(userId, input))
  )

  return server
}
