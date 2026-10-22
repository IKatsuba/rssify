import { z } from "zod"

// One set of inputs for the server actions, /api/v1 and MCP (design §5.5),
// so the three adapters accept and refuse exactly the same things.

const id = z.string().min(1)

// Strict objects, so { url, source } together matches neither branch.
export const subscribeInput = z.union([
  z.strictObject({ url: z.string() }),
  z.strictObject({ source: z.string() }),
])

export const unsubscribeInput = z.object({ feedId: id })

export const listEntriesInput = z.object({
  feedId: id.optional(),
  unreadOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: id.optional(),
})

export const entryInput = z.object({ entryId: id })
export const getEntryInput = entryInput
export const markReadInput = entryInput
export const markUnreadInput = entryInput

// upTo is a list's asOf: a Date from an action, an ISO string over JSON.
export const markAllReadInput = z.object({
  feedId: id.optional(),
  upTo: z.union([
    z.date(),
    z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  ]),
})

export const createApiKeyInput = z.object({
  name: z.string().trim().min(1).max(64),
})

export const revokeApiKeyInput = z.object({ keyId: id })

export const disconnectAppInput = z.object({ clientId: id })
