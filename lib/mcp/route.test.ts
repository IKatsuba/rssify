import { beforeEach, describe, expect, test } from "bun:test"
import { generateKeyPair, SignJWT } from "jose"

import * as route from "@/app/api/mcp/route"
import { auth, MCP_RESOURCE } from "@/lib/auth"
import { db } from "@/test/db"
import { answerJwksInProcess } from "@/test/jwks"
import { createUserWithSession, mintMcpToken } from "@/test/mcp-token"
import {
  callTool,
  type Era,
  LEGACY_VERSION,
  mcpRequest,
  MCP_URL,
  readRpc,
} from "@/test/mcp-rpc"

answerJwksInProcess()

const ISSUER = "http://localhost:3210/api/auth"
const METADATA =
  'resource_metadata="http://localhost:3210/.well-known/oauth-protected-resource/api/mcp"'

const listFeeds = (headers: HeadersInit = {}, era?: Era) =>
  route.POST(mcpRequest("tools/call", { name: "list_feeds" }, { era, headers }))

async function expectUnauthorized(res: Response) {
  expect(res.status).toBe(401)
  expect(res.headers.get("www-authenticate")).toContain(METADATA)
}

async function expectApiError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status)
  expect((await res.json()).error.code).toBe(code)
  return res
}

let token: string
let cookie: string
let key: string

beforeEach(async () => {
  const minted = await mintMcpToken("u1")
  token = minted.access_token
  cookie = minted.cookie
  key = (await auth.api.createApiKey({ body: { userId: "u1" } })).key
  await db.feed.create({
    data: {
      id: "a",
      url: "https://a.example.com/feed.xml",
      title: "Alpha",
      subscriptions: { create: { userId: "u1" } },
      entries: {
        create: {
          id: "a1",
          guid: "a1",
          title: "Entry a1",
          sortAt: new Date(Date.UTC(2026, 0, 1)),
        },
      },
    },
  })
})

test("exports only POST, with maxDuration 60", () => {
  expect(Object.keys(route).sort()).toEqual(["POST", "maxDuration"])
  expect(route.maxDuration).toBe(60)
})

describe("OAuth", () => {
  test("a real token reaches the tools as its user", async () => {
    const res = await listFeeds({ authorization: `Bearer ${token}` })
    expect(res.status).toBe(200)
    const body = await readRpc(res)
    expect(body.result.structuredContent.subscriptions[0].feed.id).toBe("a")
  })

  test("no credentials → 401 with the resource metadata", async () => {
    await expectUnauthorized(await listFeeds())
  })

  test("Bearer not-a-jwt → 401", async () => {
    await expectUnauthorized(
      await listFeeds({ authorization: "Bearer not-a-jwt" })
    )
  })

  const good = {
    iss: ISSUER,
    aud: MCP_RESOURCE,
    sub: "u1",
    azp: "client-1",
    scope: "reader",
  }
  const ownKey = async (payload: Record<string, unknown>) =>
    (await auth.api.signJWT({ body: { payload } })).token
  const past = Math.floor(Date.now() / 1000) - 3600
  const noAzp: Record<string, unknown> = { ...good }
  delete noAzp.azp
  for (const [name, payload] of [
    ["wrong aud", { ...good, aud: "http://localhost:3210/api/other" }],
    ["wrong iss", { ...good, iss: "http://localhost:3210/elsewhere" }],
    ["expired", { ...good, iat: past - 60, exp: past }],
    ["no azp", noAzp],
  ] as const) {
    test(`${name} → 401`, async () => {
      const bad = await ownKey(payload)
      await expectUnauthorized(
        await listFeeds({ authorization: `Bearer ${bad}` })
      )
    })
  }

  test("our key with every claim right passes (control)", async () => {
    const res = await listFeeds({
      authorization: `Bearer ${await ownKey(good)}`,
    })
    expect(res.status).toBe(200)
  })

  test("a token signed by a foreign key → 401", async () => {
    const { privateKey } = await generateKeyPair("EdDSA")
    const { kid } = (await auth.api.getJwks()).keys[0]
    const foreign = await new SignJWT(good)
      .setProtectedHeader({ alg: "EdDSA", kid })
      .setExpirationTime("1h")
      .sign(privateKey)
    await expectUnauthorized(
      await listFeeds({ authorization: `Bearer ${foreign}` })
    )
  })

  test("no reader scope → 403 insufficient_scope", async () => {
    const { access_token } = await mintMcpToken("u2", "offline_access")
    const res = await listFeeds({ authorization: `Bearer ${access_token}` })
    expect(res.status).toBe(403)
    expect(res.headers.get("www-authenticate")).toContain(
      'error="insufficient_scope"'
    )
  })

  test("a deleted user's token → 401", async () => {
    await db.user.delete({ where: { id: "u1" } })
    await expectUnauthorized(
      await listFeeds({ authorization: `Bearer ${token}` })
    )
  })

  test("?access_token= is ignored", async () => {
    const request = mcpRequest("tools/call", { name: "list_feeds" })
    const res = await route.POST(
      new Request(`${MCP_URL}?access_token=${token}`, {
        method: "POST",
        headers: request.headers,
        body: await request.text(),
      })
    )
    await expectUnauthorized(res)
  })

  test("Bearer rss_… (a valid API key) → 401", async () => {
    await expectUnauthorized(
      await listFeeds({ authorization: `Bearer ${key}` })
    )
  })

  test("a valid session cookie alone → 401", async () => {
    const own = await createUserWithSession("u3")
    await expectUnauthorized(await listFeeds({ cookie: own }))
    await expectUnauthorized(await listFeeds({ cookie }))
  })
})

describe("x-api-key", () => {
  test("a valid key reaches the tools as its user", async () => {
    const res = await listFeeds({ "x-api-key": key })
    expect(res.status).toBe(200)
    const body = await readRpc(res)
    expect(body.result.structuredContent.subscriptions).toHaveLength(1)
  })

  test("an invalid, revoked or expired key → 401", async () => {
    await expectApiError(
      await listFeeds({ "x-api-key": "rss_nope" }),
      401,
      "unauthorized"
    )
    await db.apikey.updateMany({
      where: { referenceId: "u1" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await expectApiError(
      await listFeeds({ "x-api-key": key }),
      401,
      "unauthorized"
    )
    await db.apikey.deleteMany({ where: { referenceId: "u1" } })
    await expectApiError(
      await listFeeds({ "x-api-key": key }),
      401,
      "unauthorized"
    )
  })

  // A present key is the only credential looked at, even beside a good token.
  test("an invalid key beside a valid token → 401", async () => {
    await expectApiError(
      await listFeeds({
        "x-api-key": "rss_nope",
        authorization: `Bearer ${token}`,
      }),
      401,
      "unauthorized"
    )
  })

  test("the 121st call in a minute → 429 with Retry-After", async () => {
    for (let i = 0; i < 120; i++) {
      expect((await listFeeds({ "x-api-key": key })).status).toBe(200)
    }
    const res = await expectApiError(
      await listFeeds({ "x-api-key": key }),
      429,
      "rate_limited"
    )
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1)
  })
})

describe("Origin", () => {
  test("a foreign Origin → 403 before any credential is checked", async () => {
    for (const headers of [
      { origin: "https://evil.example.com", "x-api-key": key } as HeadersInit,
      { origin: "https://evil.example.com", authorization: `Bearer ${token}` },
      { origin: "https://evil.example.com" },
    ]) {
      expect((await listFeeds(headers)).status).toBe(403)
    }
  })

  test("our own Origin, or none, is served", async () => {
    const res = await listFeeds({
      origin: "http://localhost:3210",
      "x-api-key": key,
    })
    expect(res.status).toBe(200)
  })
})

describe("stateless serving", () => {
  test("a 2025-era initialize is answered without a session", async () => {
    const res = await route.POST(
      mcpRequest(
        "initialize",
        {
          protocolVersion: LEGACY_VERSION,
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
        { era: "legacy", headers: { "x-api-key": key } }
      )
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("mcp-session-id")).toBeNull()
    const body = await readRpc(res)
    expect(body.result.protocolVersion).toBe(LEGACY_VERSION)
    expect(body.result.capabilities.tools).toBeDefined()
    // The next request needs no initialize before it.
    const next = await listFeeds({ "x-api-key": key }, "legacy")
    expect(next.status).toBe(200)
  })
})

describe("each tool is reachable", () => {
  const calls: [string, Record<string, unknown>][] = [
    ["list_feeds", {}],
    ["subscribe", { url: "https://a.example.com/feed.xml" }],
    ["list_entries", {}],
    ["get_entry", { entryId: "a1" }],
    ["mark_read", { entryId: "a1" }],
    ["mark_unread", { entryId: "a1" }],
    ["mark_all_read", { upTo: new Date().toISOString() }],
    ["unsubscribe", { feedId: "a" }],
  ]
  for (const credential of ["token", "key"] as const) {
    test(`with a ${credential}`, async () => {
      const headers: Record<string, string> =
        credential === "token"
          ? { authorization: `Bearer ${token}` }
          : { "x-api-key": key }
      for (const [name, args] of calls) {
        const result = await callTool(route.POST, name, args, { headers })
        expect(result.isError, name).toBeFalsy()
      }
      expect(await db.subscription.count({ where: { userId: "u1" } })).toBe(0)
    })
  }
})
