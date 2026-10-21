import { apiKey } from "@better-auth/api-key"
import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { APIError } from "better-auth/api"
import { nextCookies } from "better-auth/next-js"

import { db } from "@/lib/db"

type EmailUser = { email: string; emailVerified: boolean }

// Never stored: the admin is whoever holds the verified ADMIN_EMAIL, so an
// unverified account that claims the address gets nothing.
export function isAdmin(user: EmailUser) {
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  if (!adminEmail) return false
  return user.emailVerified && user.email.toLowerCase() === adminEmail
}

// Runs on every user creation. Not the provider's disableSignUp, which
// cannot exempt the admin, so a fresh deploy could never get its first
// account.
export async function registrationGate(user: EmailUser) {
  if (process.env.REGISTRATION_ENABLED === "true") return
  if (isAdmin(user)) return
  throw new APIError("FORBIDDEN", {
    code: "signup_disabled",
    message: "Registration is closed",
  })
}

export const auth = betterAuth({
  database: prismaAdapter(db, { provider: "postgresql" }),
  socialProviders: {
    vercel: {
      clientId: process.env.VERCEL_CLIENT_ID!,
      clientSecret: process.env.VERCEL_CLIENT_SECRET!,
    },
  },
  session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
  databaseHooks: { user: { create: { before: registrationGate } } },
  plugins: [
    apiKey({
      defaultPrefix: "rss_",
      rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 },
    }),
    nextCookies(),
  ],
})
