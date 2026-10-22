import { describe, expect, test } from "bun:test"

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

const READER =
  "Read your feeds and entries, add and remove feeds, and mark entries read or unread."
const OFFLINE = "Stay connected until you disconnect it in Settings."

describe("scopeLines", () => {
  test("one sentence per requested scope: reader, then offline_access", () => {
    expect(scopeLines("reader offline_access")).toEqual([READER, OFFLINE])
    expect(scopeLines("offline_access reader")).toEqual([READER, OFFLINE])
  })

  test("a scope without a sentence follows by its raw name", () => {
    expect(scopeLines("zeta constructor offline_access reader")).toEqual([
      READER,
      OFFLINE,
      "zeta",
      "constructor",
    ])
  })

  test("repeats and blanks are dropped", () => {
    expect(scopeLines(" reader  reader ")).toEqual([READER])
    expect(scopeLines(null)).toEqual([])
  })
})

describe("describeClient", () => {
  test("name and client_uri host", () => {
    expect(
      describeClient({
        client_id: "abc",
        client_name: "Claude Code",
        client_uri: "https://claude.ai/code",
      })
    ).toEqual({ name: "Claude Code", host: "claude.ai" })
  })

  test("no name: the client_uri host", () => {
    expect(
      describeClient({
        client_id: "abc",
        client_uri: "https://app.example.com",
      })
    ).toEqual({ name: "app.example.com", host: "app.example.com" })
  })

  test("CIMD without name or uri: the client_id URL's host", () => {
    expect(
      describeClient({ client_id: "https://cimd.example.com/client.json" })
    ).toEqual({ name: "cimd.example.com", host: "cimd.example.com" })
  })

  test("CIMD with a name but no uri: the client_id host for the line", () => {
    expect(
      describeClient({
        client_id: "https://cimd.example.com/client.json",
        client_name: "Tool",
      })
    ).toEqual({ name: "Tool", host: "cimd.example.com" })
  })

  test("no name and no host: the raw client_id, and no host line", () => {
    expect(describeClient({ client_id: "abc" })).toEqual({
      name: "abc",
      host: undefined,
    })
  })

  test("a non-HTTPS client_id is not taken as a host", () => {
    expect(describeClient({ client_id: "http://plain.example.com/c" })).toEqual(
      { name: "http://plain.example.com/c", host: undefined }
    )
  })
})

test("oauthQueryOf keeps repeated parameters", () => {
  expect(oauthQueryOf({ a: "1", ba_param: ["a", "b"], none: undefined })).toBe(
    "a=1&ba_param=a&ba_param=b"
  )
})

describe("loadConsent", () => {
  async function signedQuery() {
    const cookie = await createUserWithSession("u1")
    const clientId = await createMcpClient(cookie, "Test client")
    const { location } = await authorize(cookie, clientId)
    expect(location.pathname).toBe("/consent")
    return { cookie, params: Object.fromEntries(groupParams(location)) }
  }

  function groupParams(url: URL) {
    const out = new Map<string, string | string[]>()
    for (const key of new Set(url.searchParams.keys())) {
      const all = url.searchParams.getAll(key)
      out.set(key, all.length === 1 ? all[0] : all)
    }
    return out
  }

  test("a signed query with a session asks, naming client and scopes", async () => {
    const { cookie, params } = await signedQuery()
    expect(
      await loadConsent(oauthQueryOf(params), new Headers({ cookie }))
    ).toEqual({
      kind: "ask",
      name: "Test client",
      host: "client.example.com",
      scopes: [READER, OFFLINE],
    })
  })

  test("without a session: sign in, with the same query", async () => {
    const { params } = await signedQuery()
    expect(await loadConsent(oauthQueryOf(params), new Headers())).toEqual({
      kind: "sign_in",
      query: oauthQueryOf(params),
    })
  })

  test("a changed parameter fails the signature", async () => {
    const { cookie, params } = await signedQuery()
    const tampered = { ...params, scope: "reader" }
    expect(
      await loadConsent(oauthQueryOf(tampered), new Headers({ cookie }))
    ).toEqual({
      kind: "not_found",
    })
  })

  test("no query at all is not found", async () => {
    expect(await loadConsent("", new Headers())).toEqual({ kind: "not_found" })
  })
})
