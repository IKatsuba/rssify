import { handleCallback } from "@vercel/queue"

import { refreshFromMessage } from "@/lib/ingest/consumer"

export const maxDuration = 60

export const POST = handleCallback(async (message) => {
  await refreshFromMessage(message)
})
