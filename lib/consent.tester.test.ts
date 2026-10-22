import { expect, test } from "bun:test"

import {
  authorize,
  createMcpClient,
  createUserWithSession,
} from "@/test/mcp-token"

import {
  describeClient,
  loadConsent,
  oauthQueryOf,
  scopeLines,
} from "./consent"
import { db } from "./db"

async function consentQuery() {
  const cookie = await createUserWithSession("consent-edge")
  const clientId = await createMcpClient(cookie)
  const { location } = await authorize(cookie, clientId)
  expect(location.pathname).toBe("/consent")
  return { cookie, clientId, query: location.search.slice(1) }
}

test("a duplicate signed scope cannot enlarge the request, even without a session", async () => {
  const { cookie, query } = await consentQuery()
  for (const headers of [new Headers(), new Headers({ cookie })]) {
    expect(await loadConsent(`${query}&scope=reader%20extra`, headers)).toEqual(
      { kind: "not_found" }
    )
  }
})

test("a client removed after authorization cannot be consented to", async () => {
  const { cookie, clientId, query } = await consentQuery()
  await db.oauthClient.delete({ where: { clientId } })
  expect(await loadConsent(query, new Headers({ cookie }))).toEqual({
    kind: "not_found",
  })
})

test("rebuilding the signed query preserves encoded characters and all repeated signed names", async () => {
  const { cookie, query } = await consentQuery()
  const params = new URLSearchParams(query)
  const grouped: Record<string, string[]> = {}
  for (const name of new Set(params.keys())) grouped[name] = params.getAll(name)
  const result = await loadConsent(
    oauthQueryOf(grouped),
    new Headers({ cookie })
  )
  expect(result.kind).toBe("ask")
})

test("unsafe client URI falls back to the HTTPS client identifier host", () => {
  expect(
    describeClient({
      client_id: "https://metadata.example.invalid/client.json",
      client_uri: "javascript:alert(1)",
    })
  ).toEqual({
    name: "metadata.example.invalid",
    host: "metadata.example.invalid",
  })
  expect(scopeLines("__proto__ toString reader __proto__")).toEqual([
    "Read your feeds and entries, add and remove feeds, and mark entries read or unread.",
    "__proto__",
    "toString",
  ])
})
