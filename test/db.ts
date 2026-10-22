import { beforeEach } from "bun:test"

import { db } from "@/lib/db"
import { assertLocalDatabaseUrl } from "@/lib/local-database"

// Every test file that touches the database imports this module, so the
// guard runs before any truncation can reach a database that is not the
// local throwaway one.
export function assertTestDatabaseUrl(url: string | undefined) {
  const database = assertLocalDatabaseUrl(url)
  if (database !== "rssify_test") {
    throw new Error(`Refusing to run: database is ${database}`)
  }
}

assertTestDatabaseUrl(process.env.DATABASE_URL)

// jwks survives so one signing key lives for the whole test process.
// oauthResource survives because the provider seeds the MCP resource row
// from config only once per process, the first time it is needed.
const KEEP = ["jwks", "oauthResource", "_prisma_migrations"]

export async function truncateAll() {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  const names = tables
    .map((t) => t.tablename)
    .filter((name) => !KEEP.includes(name))
    .map((name) => `"public"."${name}"`)
  if (names.length === 0) return
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${names.join(", ")} CASCADE`)
}

beforeEach(truncateAll)

export { db }
