import { APIError } from "better-auth/api"

import { auth } from "@/lib/auth"

// Key management goes through the session only (design §9): the plugin's
// endpoints take the request's session headers and scope every call to that
// user, so a key never manages keys.

// Settings' table: newest first, without the key itself (never stored in
// the clear). lastRequest is when the key was last used; null is "Never".
export async function listApiKeys(headers: Headers) {
  const { apiKeys } = await auth.api.listApiKeys({ headers })
  return apiKeys
    .map(({ id, name, start, createdAt, lastRequest }) => ({
      id,
      name,
      start,
      createdAt: new Date(createdAt),
      lastRequest: lastRequest ? new Date(lastRequest) : null,
    }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

// The whole key is in this answer only; Settings shows it once.
export async function createApiKey(headers: Headers, name: string) {
  const { key } = await auth.api.createApiKey({ headers, body: { name } })
  return { key }
}

// The plugin answers NOT_FOUND for a key that is missing or not the
// session's, so another person's key id reveals nothing.
export async function revokeApiKey(headers: Headers, keyId: string) {
  try {
    await auth.api.deleteApiKey({ headers, body: { keyId } })
  } catch (e) {
    if (e instanceof APIError && e.status === "NOT_FOUND") {
      return { ok: false as const, code: "not_found" as const }
    }
    throw e
  }
  return { ok: true as const }
}
