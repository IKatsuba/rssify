import { send } from "@vercel/queue"

import { handleCronRefresh } from "@/lib/ingest/cron"

export const maxDuration = 300

export function GET(request: Request) {
  return handleCronRefresh(request, (feedId, idempotencyKey) =>
    send("feed-refresh", { feedId }, { idempotencyKey })
  )
}
