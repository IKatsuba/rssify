import { apiKey } from "@better-auth/api-key"
import { cimd } from "@better-auth/cimd"
import { fetchClientMetadataResource } from "@better-auth/cimd/node"
import { mcp } from "@better-auth/mcp"
import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { APIError } from "better-auth/api"
import { nextCookies } from "better-auth/next-js"
import { jwt } from "better-auth/plugins"

import { db } from "@/lib/db"

// The RFC 8707 resource MCP tokens are bound to; their aud must equal it.
export const MCP_RESOURCE = `${process.env.BETTER_AUTH_URL}/api/mcp`
export const MCP_SCOPE = "reader"
// Explicit, because the provider default also offers the OIDC identity
// scopes, which rssify does not use (design §9).
const MCP_SCOPES = ["offline_access", MCP_SCOPE]

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
  // jwt()'s session-to-JWT endpoint; nothing here needs it.
  disabledPaths: ["/token"],
  plugins: [
    jwt(),
    mcp({
      loginPage: "/sign-in",
      consentPage: "/consent",
      resource: MCP_RESOURCE,
      scopes: MCP_SCOPES,
      resources: [
        {
          identifier: MCP_RESOURCE,
          name: "rssify MCP",
          allowedScopes: MCP_SCOPES,
        },
      ],
      clientRegistrationDefaultScopes: MCP_SCOPES,
      // Dynamic client registration stays off: CIMD only (design §5.5).
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    apiKey({
      defaultPrefix: "rss_",
      // Settings takes names of 1–64 characters (design §2.5); the default is 32.
      maximumNameLength: 64,
      // Settings shows the key by its first 8 characters, prefix included.
      startingCharactersConfig: { charactersLength: 8 },
      rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 },
    }),
    nextCookies(),
  ],
})
