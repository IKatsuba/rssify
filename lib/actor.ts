import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"

import { auth, isAdmin } from "@/lib/auth"

export type Actor = { userId: string; isAdmin: boolean }

// Pages and actions: the session cookie only. enableSessionForAPIKeys stays
// off, so an API key never turns into a session here.
export async function requireUser(): Promise<Actor> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/sign-in")
  return { userId: session.user.id, isAdmin: isAdmin(session.user) }
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
