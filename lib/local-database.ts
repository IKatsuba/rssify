import { parse } from "pg-connection-string"

// For dev scripts and tests that write freely: they must only ever reach the
// docker Postgres. Returns the database name for callers that also pin it.
export function assertLocalDatabaseUrl(url: string | undefined) {
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
  return database
}
