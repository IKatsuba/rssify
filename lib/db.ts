import { PrismaNeon } from "@prisma/adapter-neon"
import { PrismaPg } from "@prisma/adapter-pg"

import { PrismaClient } from "@/lib/generated/prisma/client"

function createClient() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is not set")
  const { hostname } = new URL(connectionString)
  // Neon's serverless driver talks over WebSockets, which suits functions;
  // the local docker Postgres only speaks the plain protocol.
  const adapter = hostname.endsWith(".neon.tech")
    ? new PrismaNeon({ connectionString })
    : new PrismaPg({ connectionString })
  return new PrismaClient({ adapter })
}

// One client per instance: dev hot reload and warm functions reuse it.
const globalForDb = globalThis as unknown as { db?: PrismaClient }

export const db = globalForDb.db ?? createClient()
globalForDb.db = db
