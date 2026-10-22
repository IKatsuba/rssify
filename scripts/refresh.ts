// Runs one refresh cycle against the docker database without the queue:
// the cron route's claim, then each claimed feed refreshed inline.
//
//   bun --env-file=.env.local scripts/refresh.ts
import { db } from "@/lib/db"
import { fanOut } from "@/lib/ingest/fan-out"
import { refreshFeed } from "@/lib/ingest/refresh"
import { assertLocalDatabaseUrl } from "@/lib/local-database"

assertLocalDatabaseUrl(process.env.DATABASE_URL)

try {
  const counts = await fanOut((id) => refreshFeed(id))
  console.log(counts)
} finally {
  await db.$disconnect()
}
