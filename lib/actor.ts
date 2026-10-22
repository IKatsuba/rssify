import { requireMcpAuth } from "@better-auth/mcp"
import { createResourceServerChallenge } from "@better-auth/oauth-provider"
import { APIError } from "better-auth/api"
import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"

import {
  auth,
  isAdmin,
  MCP_RESOURCE,
  MCP_SCOPE,
  MCP_SCOPES,
} from "@/lib/auth"
import { db } from "@/lib/db"

export type Actor = { userId: string; isAdmin: boolean }

// Pages and actions: the session cookie only. enableSessionForAPIKeys stays
// off, so an API key never turns into a session here.
// The email is for the sidebar foot only, never for an ownership check.
export async function requireUser(): Promise<Actor & { email: string }> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/sign-in")
  return {
    userId: session.user.id,
    isAdmin: isAdmin(session.user),
    email: session.user.email,
  }
}

// notFound rather than 403, so /admin does not reveal that it exists.
export async function requireAdmin(): Promise<Actor> {
  const actor = await requireUser()
  if (!actor.isAdmin) notFound()
  return actor
}

export function apiError(
  status: number,
  code: string,
  message: string,
  init?: ResponseInit
) {
  return Response.json({ error: { code, message } }, { ...init, status })
}

// /api/v1 and the key branch of /api/mcp: only x-api-key, never a cookie, so
// these handlers have no CSRF surface. A Response is the refusal to return
// as is; an Actor is never admin, even for the admin's own key.
export async function requireApiKey(
  requestHeaders: Headers
): Promise<Actor | Response> {
  const key = requestHeaders.get("x-api-key")
  if (!key) return apiError(401, "unauthorized", "Missing x-api-key header")
  const result = await auth.api.verifyApiKey({ body: { key } })
  if (result.valid && result.key) {
    return { userId: result.key.referenceId, isAdmin: false }
  }
  if (result.error?.code === "RATE_LIMITED") {
    const tryAgainIn = Number(
      (result.error as { details?: { tryAgainIn?: number } }).details
        ?.tryAgainIn ?? 60_000
    )
    return apiError(429, "rate_limited", "Too many requests", {
      headers: {
        "Retry-After": String(Math.max(1, Math.ceil(tryAgainIn / 1000))),
      },
    })
  }
  return apiError(401, "unauthorized", "Invalid API key")
}

// The same JSON-RPC 401 and challenge requireMcpAuth gives a bad token, so a
// client whose user is gone starts the authorization flow again.
function mcpUnauthorized() {
  const challenge = createResourceServerChallenge(
    new APIError("UNAUTHORIZED", { message: "Unknown user" }),
    MCP_RESOURCE,
    { challengeScopes: MCP_SCOPES }
  )!
  const responseHeaders = new Headers(challenge.headers)
  responseHeaders.set("Content-Type", "application/json")
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: challenge.message },
      id: null,
    },
    { status: 401, headers: responseHeaders }
  )
}

// The OAuth branch of /api/mcp. requireMcpAuth checks the JWT against our
// JWKS (iss, aud = MCP_RESOURCE, exp, azp) and the reader scope, and answers
// 401 or 403 insufficient_scope itself. Only reader is required, but a 401
// names offline_access too, so a client asks for a refresh token. Tokens are
// not stored, so one lookup by primary key refuses a deleted user's token at
// once. Never admin.
export function withMcpAuth(
  handler: (request: Request, actor: Actor) => Promise<Response>
) {
  return requireMcpAuth(
    auth,
    async (request, claims) => {
      const user = claims.sub
        ? await db.user.findUnique({
            where: { id: claims.sub },
            select: { id: true },
          })
        : null
      if (!user) return mcpUnauthorized()
      return handler(request, { userId: user.id, isAdmin: false })
    },
    {
      resource: MCP_RESOURCE,
      requiredScopes: [MCP_SCOPE],
      challengeScopes: MCP_SCOPES,
    }
  )
}
