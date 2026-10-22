import { timingSafeEqual } from "node:crypto"

import { deleteExpiredAuthRows } from "@/lib/auth-cleanup"

import { fanOut, tickOf } from "./fan-out"

export type CronEnqueue = (
  feedId: string,
  idempotencyKey: string
) => Promise<unknown>

function authorized(header: string | null, secret: string) {
  const given = Buffer.from(header ?? "")
  const expected = Buffer.from(`Bearer ${secret}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

// The cron route's body, kept out of the route so tests never load the
// queue SDK. Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`.
export async function handleCronRefresh(
  request: Request,
  enqueue: CronEnqueue,
  { now = new Date() }: { now?: Date } = {}
): Promise<Response> {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error("cron refresh refused: CRON_SECRET is not set")
    return Response.json({ error: "not_configured" }, { status: 500 })
  }
  if (!authorized(request.headers.get("authorization"), secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  const tick = tickOf(now)
  const counts = await fanOut((feedId) => enqueue(feedId, `${feedId}:${tick}`))
  // At the end of every run (design §5.5): no cron or job of its own. A
  // failure is logged, so the claimed feeds are still reported.
  await deleteExpiredAuthRows(now).catch((error) =>
    console.error("auth cleanup failed", error)
  )
  return Response.json(counts)
}
