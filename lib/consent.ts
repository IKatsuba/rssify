import { verifyOAuthQueryParams } from "@better-auth/oauth-provider"

import { auth } from "@/lib/auth"

const SCOPE_SENTENCES: Record<string, string> = {
  reader:
    "Read your feeds and entries, add and remove feeds, and mark entries read or unread.",
  offline_access: "Stay connected until you disconnect it in Settings.",
}

// Every requested scope gets a line, so nothing is granted that was not
// shown. What the app may do comes before how long; a scope without a
// sentence follows, by its raw name, in the order requested.
export function scopeLines(scope: string | null) {
  const requested = new Set((scope ?? "").split(" ").filter(Boolean))
  const known = Object.keys(SCOPE_SENTENCES).filter((name) =>
    requested.has(name)
  )
  const others = [...requested].filter(
    (name) => !Object.hasOwn(SCOPE_SENTENCES, name)
  )
  return [...known.map((name) => SCOPE_SENTENCES[name]), ...others]
}

function hostOf(url: string | undefined, httpsOnly = false) {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (httpsOnly && parsed.protocol !== "https:") return undefined
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined
    return parsed.host
  } catch {
    return undefined
  }
}

// A CIMD client's id is the HTTPS URL its metadata was fetched from, so its
// host is a true name for the app when the document gives no client_uri.
export function describeClient(client: {
  client_id: string
  client_name?: string
  client_uri?: string
}) {
  const host = hostOf(client.client_uri) ?? hostOf(client.client_id, true)
  return { name: client.client_name || host || client.client_id, host }
}

type SearchParams = Record<string, string | string[] | undefined>

// Rebuilt with repeats kept: the signature covers every parameter, ba_param
// included, which appears once per signed name.
export function oauthQueryOf(searchParams: SearchParams) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(searchParams)) {
    for (const item of [value ?? []].flat()) query.append(key, item)
  }
  return query.toString()
}

export type ConsentRequest =
  | { kind: "not_found" }
  | { kind: "sign_in"; query: string }
  | { kind: "ask"; name: string; host?: string; scopes: string[] }

// query is the page's whole query string, as oauthQueryOf builds it.
export async function loadConsent(
  query: string,
  requestHeaders: Headers
): Promise<ConsentRequest> {
  const { secret } = await auth.$context
  if (!(await verifyOAuthQueryParams(query, secret))) {
    return { kind: "not_found" }
  }
  const session = await auth.api.getSession({ headers: requestHeaders })
  if (!session) return { kind: "sign_in", query }
  const params = new URLSearchParams(query)
  const clientId = params.get("client_id")
  if (!clientId) return { kind: "not_found" }
  const client = await auth.api
    .getOAuthClientPublic({
      query: { client_id: clientId },
      headers: requestHeaders,
    })
    .catch(() => null)
  if (!client) return { kind: "not_found" }
  return {
    kind: "ask",
    ...describeClient(client),
    scopes: scopeLines(params.get("scope")),
  }
}
