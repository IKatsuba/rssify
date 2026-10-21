import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo, LookupFunction } from "node:net"

import { createSafeFetch, isPublicAddress, safeFetch } from "./safe-fetch"

type Answer = { address: string; family: number }

// A resolver that never touches DNS: it answers every name with `answers`.
function fakeLookup(answers: Answer[] | Error) {
  const calls: string[] = []
  const lookup = ((hostname, _options, callback) => {
    calls.push(hostname)
    if (answers instanceof Error) callback(answers, "", 0)
    else callback(null, answers as never)
  }) as LookupFunction
  return { lookup, calls }
}

const v4 = (address: string): Answer => ({ address, family: 4 })

let server: Server
let port: number
let connections = 0

beforeAll(async () => {
  server = createServer((_req, res) => res.end("<rss/>"))
  server.on("connection", () => connections++)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

describe("isPublicAddress", () => {
  test.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "not an address",
  ])("%s is not public", (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  test.each(["93.184.215.14", "2606:4700::1111", "::ffff:93.184.215.14"])(
    "%s is public",
    (address) => {
      expect(isPublicAddress(address)).toBe(true)
    }
  )
})

describe("URL rules", () => {
  // A private answer, so a rule that let a URL through could not leave the
  // machine either.
  const { lookup, calls } = fakeLookup([v4("10.0.0.1")])
  const fetch = createSafeFetch({ lookup })

  test.each([
    "not a url",
    "ftp://example.com/feed.xml",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@example.com/feed.xml",
    "https://user@example.com/feed.xml",
    `https://example.com/${"a".repeat(2048)}`,
  ])("%s is invalid_url", async (url) => {
    await expect(fetch(url)).rejects.toMatchObject({ code: "invalid_url" })
  })

  test.each([
    "http://example.com:8080/feed.xml",
    "https://example.com:8443/feed.xml",
    "http://example.com:22/",
  ])("%s is blocked by port", async (url) => {
    await expect(fetch(url)).rejects.toMatchObject({
      code: "blocked",
      message: "the port isn’t allowed",
    })
  })

  // 443 and 80 are allowed whatever the scheme; the private answer stops them.
  test.each(["http://example.com:443/", "https://example.com:80/"])(
    "%s passes the port rule",
    async (url) => {
      await expect(fetch(url)).rejects.toMatchObject({
        code: "blocked",
        message: "the address isn’t allowed",
      })
      calls.length = 0
    }
  )

  test.each([
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://0x7f.1/",
    "http://2130706433/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:a00:1]/",
  ])("literal %s is blocked", async (url) => {
    await expect(fetch(url)).rejects.toMatchObject({ code: "blocked" })
  })

  test("no rejected URL reached the resolver", () => {
    expect(calls).toEqual([])
  })
})

describe("the guarded connection", () => {
  // The listener's port stands in for 80/443; the address rule stays strict
  // unless a test says otherwise.
  const make = (
    answers: Answer[] | Error,
    allowAddress?: (a: string) => boolean
  ) => {
    const fake = fakeLookup(answers)
    return {
      ...fake,
      fetch: createSafeFetch({
        lookup: fake.lookup,
        ports: [port],
        allowAddress,
      }),
    }
  }

  test("goes through our connect and lookup, reaching the listener", async () => {
    const { fetch, calls } = make([v4("127.0.0.1")], () => true)
    const before = connections
    const result = await fetch(`http://feed.test:${port}/feed.xml`)
    expect(result).toMatchObject({ status: 200, text: "<rss/>", kind: "xml" })
    expect(calls).toEqual(["feed.test"])
    expect(connections).toBe(before + 1)
  })

  test("a literal loopback address never connects", async () => {
    const { fetch, calls } = make([v4("127.0.0.1")])
    const before = connections
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({
      code: "blocked",
    })
    expect(calls).toEqual([])
    expect(connections).toBe(before)
  })

  test.each([
    [[v4("127.0.0.1")]],
    [[v4("10.0.0.1")]],
    [[v4("169.254.169.254")]],
    [[{ address: "::1", family: 6 }]],
    [[{ address: "::ffff:127.0.0.1", family: 6 }]],
    [[v4("93.184.215.14"), v4("127.0.0.1")]],
    [[v4("127.0.0.1"), v4("93.184.215.14")]],
    [[]],
  ])("a name resolving to %j is blocked before connecting", async (answers) => {
    const { fetch, calls } = make(answers)
    const before = connections
    await expect(fetch(`http://feed.test:${port}/`)).rejects.toMatchObject({
      code: "blocked",
    })
    expect(calls).toEqual(["feed.test"])
    expect(connections).toBe(before)
  })

  test("a socket that reaches a disallowed address is destroyed", async () => {
    // Allows the lookup's answer, then refuses the socket's remoteAddress,
    // as if the address had changed between the two.
    let checks = 0
    const { fetch } = make([v4("127.0.0.1")], () => ++checks === 1)
    const connected = new Promise((resolve) =>
      server.once("connection", resolve)
    )
    await expect(fetch(`http://feed.test:${port}/`)).rejects.toMatchObject({
      code: "blocked",
    })
    expect(checks).toBe(2)
    await connected
  })

  test("a resolver failure is unreachable", async () => {
    const error = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
      code: "ENOTFOUND",
    })
    const { fetch } = make(error)
    await expect(fetch(`http://feed.test:${port}/`)).rejects.toMatchObject({
      code: "unreachable",
    })
  })
})

describe("the default safeFetch", () => {
  test("blocks a loopback address", async () => {
    await expect(safeFetch("http://127.0.0.1/")).rejects.toMatchObject({
      code: "blocked",
    })
  })

  test("blocks port 8080 before resolving", async () => {
    await expect(safeFetch("http://example.com:8080/")).rejects.toMatchObject({
      code: "blocked",
    })
  })
})
