import { db } from "@/lib/db"

const CHUNK = 50
const SEND_BUDGET = 240_000
const TICK = 15 * 60_000

export type FanOutOptions = {
  // Milliseconds since the epoch; tests move it to reach the send budget.
  clock?: () => number
}

export type FanOutResult = { claimed: number; sent: number; failed: number }

// The cron run's start rounded down to its 15-minute slot, so a duplicate
// run in the same slot sends the same idempotency keys.
export function tickOf(date: Date): string {
  return new Date(Math.floor(date.getTime() / TICK) * TICK).toISOString()
}

// The only claim: one statement takes due, subscribed feeds and leases them
// for 30 minutes, so a lost message, a dead consumer or a failed send just
// lets the feed come due again. Gone feeds have a null nextFetchAt.
async function claimDueFeeds(): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "Feed" SET "nextFetchAt" = now() + interval '30 minutes'
    WHERE id IN (
      SELECT id FROM "Feed" f
      WHERE f."nextFetchAt" <= now()
        AND EXISTS (SELECT 1 FROM "Subscription" s WHERE s."feedId" = f.id)
      ORDER BY f."nextFetchAt" LIMIT 500
      FOR UPDATE SKIP LOCKED)
    RETURNING id`
  return rows.map((row) => row.id)
}

export async function fanOut(
  enqueue: (feedId: string) => Promise<unknown>,
  { clock = Date.now }: FanOutOptions = {}
): Promise<FanOutResult> {
  const started = clock()
  const ids = await claimDueFeeds()
  let sent = 0
  let failed = 0
  for (let i = 0; i < ids.length; i += CHUNK) {
    // Past the budget the rest stay leased and come due again.
    if (clock() - started >= SEND_BUDGET) break
    const chunk = ids.slice(i, i + CHUNK)
    const results = await Promise.allSettled(chunk.map((id) => enqueue(id)))
    results.forEach((result, j) => {
      if (result.status === "fulfilled") {
        sent++
        return
      }
      failed++
      const reason = result.reason
      console.error(
        `feed-refresh send failed for ${chunk[j]}:`,
        reason instanceof Error ? reason.message : String(reason)
      )
    })
  }
  return { claimed: ids.length, sent, failed }
}
