import { beforeEach } from "bun:test"
import { parse } from "pg-connection-string"

import { db } from "@/lib/db"

// Every test file that touches the database imports this module, so the
// guard runs before any truncation can reach a database that is not the
// local throwaway one.
export function assertTestDatabaseUrl(url: string | undefined) {
  if (!url) throw new Error("Refusing to run: DATABASE_URL is not set")
  const { protocol } = new URL(url)
  if (protocol !== "postgresql:" && protocol !== "postgres:") {
    throw new Error(`Refusing to run: protocol is ${protocol}`)
  }
  // The driver's own parser: query parameters such as ?host= override the
  // URL's host, so checking URL.hostname alone would let them through.
  const { host, database } = parse(url)
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to run: database host is ${host}`)
  }
  if (database !== "rssify_test") {
    throw new Error(`Refusing to run: database is ${database}`)
  }
}

assertTestDatabaseUrl(process.env.DATABASE_URL)

// jwks survives so one signing key lives for the whole test process.
const KEEP = ["jwks", "_prisma_migrations"]

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
