import { handleCallback } from "@vercel/queue"

import { refreshFromMessage } from "@/lib/ingest/consumer"

export const maxDuration = 60

const handle = handleCallback(async (message) => {
  await refreshFromMessage(message)
})

// handleCallback is typed as taking Request | { request: Request }, which
// Next's route-export check rejects; a plain Request handler satisfies it.
export function POST(request: Request) {
  return handle(request)
}
