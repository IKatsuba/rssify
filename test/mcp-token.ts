import { createHash, randomBytes } from "node:crypto"

import { serializeSignedCookie } from "better-call"

import { auth, MCP_RESOURCE } from "@/lib/auth"
import { db } from "@/lib/db"

const ORIGIN = "http://localhost:3210"
// Nothing listens there: the code is read from the redirect's Location.
export const REDIRECT_URI = "http://127.0.0.1:9/cb"

export async function createUserWithSession(id: string) {
  await db.user.create({
    data: { id, name: id, email: `${id}@example.com`, emailVerified: true },
  })
  const ctx = await auth.$context
  const session = await ctx.internalAdapter.createSession(id)
  const cookie = await serializeSignedCookie(
    ctx.authCookies.sessionToken.name,
    session.token,
    ctx.secret
  )
  return cookie.split(";")[0]
}

// A public native client, as an MCP client app would be.
export async function createMcpClient(cookie: string, name = "Test client") {
  const client = await auth.api.adminCreateOAuthClient({
    headers: new Headers({ cookie }),
    body: {
      client_name: name,
      client_uri: "https://client.example.com",
      redirect_uris: [REDIRECT_URI],
      scope: "offline_access reader",
      application_type: "native",
      token_endpoint_auth_method: "none",
    },
  })
  return client.client_id
}

function base64url(bytes: Buffer) {
  return bytes.toString("base64url")
}

// The authorization code flow through auth.handler, as a browser and an MCP
// client would drive it: authorize (PKCE S256, resource) → consent → token.
// Returns where authorize sent the browser when it did not go to /consent.
export async function authorize(
  cookie: string,
  clientId: string,
  scope = "offline_access reader"
) {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash("sha256").update(verifier).digest())
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope,
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: MCP_RESOURCE,
  })
  const res = await auth.handler(
    new Request(`${ORIGIN}/api/auth/oauth2/authorize?${query}`, {
      headers: { cookie },
    })
  )
  const location = new URL(res.headers.get("location") ?? "", ORIGIN)
  return { status: res.status, location, verifier }
}

export async function consent(cookie: string, location: URL, accept = true) {
  const res = await auth.handler(
    new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ accept, oauth_query: location.search.slice(1) }),
    })
  )
  const body = (await res.json()) as { url: string }
  return new URL(body.url)
}

export async function exchangeCode(
  clientId: string,
  code: string,
  verifier: string
) {
  const res = await auth.handler(
    new Request(`${ORIGIN}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
        resource: MCP_RESOURCE,
      }),
    })
  )
  if (!res.ok) throw new Error(`token: ${res.status} ${await res.text()}`)
  return (await res.json()) as {
    access_token: string
    refresh_token?: string
    scope: string
  }
}

// A real MCP access token for a fresh user, minted in process.
export async function mintMcpToken(
  userId = "u1",
  scope = "offline_access reader"
) {
  const cookie = await createUserWithSession(userId)
  const clientId = await createMcpClient(cookie)
  const { location, verifier } = await authorize(cookie, clientId, scope)
  const redirect = await consent(cookie, location)
  const code = redirect.searchParams.get("code")
  if (!code) throw new Error(`no code in ${redirect}`)
  const tokens = await exchangeCode(clientId, code, verifier)
  return { ...tokens, cookie, clientId }
}
