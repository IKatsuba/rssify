import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type RequestListener, type Server } from "node:http"
import type { AddressInfo, LookupFunction } from "node:net"
import { gzipSync } from "node:zlib"

import {
  createSafeFetch,
  decode,
  isPublicAddress,
  safeFetch,
  type SafeFetch,
} from "./safe-fetch"

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
const rss: RequestListener = (_req, res) => res.end("<rss/>")
let handle = rss

beforeAll(async () => {
  server = createServer((req, res) => handle(req, res))
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

describe("the fetch loop", () => {
  // feed.test is the listener; private.test resolves to a private address.
  // Only 127.0.0.1 is allowed, so the private rule still bites on a hop.
  const lookup = ((hostname, _options, callback) => {
    const address = hostname === "feed.test" ? "127.0.0.1" : "10.0.0.1"
    callback(null, [v4(address)] as never)
  }) as LookupFunction
  // Made per call: the listener's port is not known until beforeAll.
  const fetch: SafeFetch = (url, options) =>
    createSafeFetch({
      lookup,
      ports: [port, 80],
      allowAddress: (address) => address === "127.0.0.1",
    })(url, options)
  const at = (path: string) => `http://feed.test:${port}${path}`

  // /hops/n redirects n times, then answers.
  const redirects: RequestListener = (req, res) => {
    const n = Number(req.url?.split("/")[2])
    if (n > 0) {
      res.writeHead(n % 2 ? 301 : 302, { location: `/hops/${n - 1}` })
      res.end()
    } else res.end("<feed/>")
  }

  afterAll(() => {
    handle = rss
  })

  test("follows redirects and returns the final URL", async () => {
    handle = redirects
    const result = await fetch(at("/hops/5"))
    expect(result).toMatchObject({
      status: 200,
      url: at("/hops/0"),
      text: "<feed/>",
      kind: "xml",
    })
  })

  test("more than five redirects is unreachable", async () => {
    handle = redirects
    await expect(fetch(at("/hops/6"))).rejects.toMatchObject({
      code: "unreachable",
      message: "too many redirects",
    })
  })

  test.each([
    ["http://10.0.0.1/feed.xml", "blocked"],
    ["http://private.test/feed.xml", "blocked"],
    ["http://feed.test:22/feed.xml", "blocked"],
    ["ftp://feed.test/feed.xml", "invalid_url"],
    ["http://user:pass@feed.test/feed.xml", "invalid_url"],
    ["http://[::1", "invalid_url"],
  ])("a redirect to %s is %s", async (location, code) => {
    handle = (_req, res) => {
      res.writeHead(302, { location })
      res.end()
    }
    await expect(fetch(at("/"))).rejects.toMatchObject({ code })
  })

  test("a redirect without a location is invalid_url", async () => {
    handle = (_req, res) => {
      res.writeHead(301)
      res.end()
    }
    await expect(fetch(at("/"))).rejects.toMatchObject({ code: "invalid_url" })
  })

  test("one deadline covers every hop", async () => {
    // Each hop alone fits well inside the deadline; the three together do not.
    handle = (req, res) => setTimeout(() => redirects(req, res), 150)
    await expect(
      fetch(at("/hops/2"), { deadline: AbortSignal.timeout(300) })
    ).rejects.toMatchObject({
      code: "unreachable",
      message: "the server took too long",
    })
  })

  test("a body that breaks off is unreachable", async () => {
    handle = (_req, res) => {
      res.writeHead(200, { "content-length": "100" })
      res.write("<rss>")
      setTimeout(() => res.destroy(), 20)
    }
    await expect(fetch(at("/"))).rejects.toMatchObject({ code: "unreachable" })
  })

  const MB = 1024 * 1024

  test("exactly 10 MB is read", async () => {
    handle = (_req, res) => res.end(Buffer.alloc(10 * MB, "<"))
    const result = await fetch(at("/"))
    expect(result.text.length).toBe(10 * MB)
  })

  test("past 10 MB is too_large, without a Content-Length", async () => {
    handle = (_req, res) => {
      const chunk = Buffer.alloc(MB, "<")
      for (let i = 0; i < 11; i++) res.write(chunk)
      res.end()
    }
    await expect(fetch(at("/"))).rejects.toMatchObject({ code: "too_large" })
  })

  test("the cap counts decoded bytes, not compressed ones", async () => {
    const body = gzipSync(Buffer.alloc(11 * MB, "<"))
    handle = (_req, res) => {
      res.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": body.length,
      })
      res.end(body)
    }
    expect(body.length).toBeLessThan(MB)
    await expect(fetch(at("/"))).rejects.toMatchObject({ code: "too_large" })
  })

  test("decodes by the XML prolog when the header has no charset", async () => {
    const body = Buffer.concat([
      Buffer.from('<?xml version="1.0" encoding="koi8-r"?><rss>'),
      Buffer.from([0xf7, 0xc5, 0xd4, 0xc5, 0xd2]),
      Buffer.from("</rss>"),
    ])
    handle = (_req, res) => {
      res.writeHead(200, { "content-type": "text/xml" })
      res.end(body)
    }
    const result = await fetch(at("/"))
    expect(result.text).toContain("<rss>Ветер</rss>")
  })

  test("sends the UA, Accept and conditional headers; 304 has no text", async () => {
    let seen: Record<string, string | string[] | undefined> = {}
    handle = (req, res) => {
      seen = req.headers
      res.writeHead(304, { etag: '"v1"' })
      res.end()
    }
    const result = await fetch(at("/"), {
      etag: '"v1"',
      lastModified: "Wed, 21 Oct 2026 07:28:00 GMT",
    })
    expect(result).toMatchObject({ status: 304, text: "", kind: "unknown" })
    expect(result.headers.get("etag")).toBe('"v1"')
    expect(seen["user-agent"]).toBe(
      "rssify/1.0 (+https://github.com/IKatsuba/rssify)"
    )
    expect(seen.accept).toStartWith("application/feed+json")
    expect(seen.accept).toContain("text/html;q=0.8")
    expect(seen["if-none-match"]).toBe('"v1"')
    expect(seen["if-modified-since"]).toBe("Wed, 21 Oct 2026 07:28:00 GMT")
  })

  test("without validators, no conditional headers are sent", async () => {
    let seen: Record<string, unknown> = {}
    handle = (req, res) => {
      seen = req.headers
      res.end("<rss/>")
    }
    await fetch(at("/"))
    expect(seen["if-none-match"]).toBeUndefined()
    expect(seen["if-modified-since"]).toBeUndefined()
  })

  test("an error status is returned with its headers, not thrown", async () => {
    handle = (_req, res) => {
      res.writeHead(503, { "retry-after": "120" })
      res.end("<html>busy</html>")
    }
    const result = await fetch(at("/"))
    expect(result).toMatchObject({ status: 503, text: "", kind: "unknown" })
    expect(result.headers.get("retry-after")).toBe("120")
  })

  test.each([
    ['  {"version":"https://jsonfeed.org/version/1.1"}', "json"],
    ["\n<rss/>", "xml"],
    [String.fromCharCode(0xfeff) + "<feed/>", "xml"],
    ["hello", "unknown"],
  ] as const)(
    "sniffs %j as %s, whatever the Content-Type",
    async (body, kind) => {
      handle = (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end(body)
      }
      expect((await fetch(at("/"))).kind).toBe(kind)
    }
  )
})

describe("decode", () => {
  const latin = Buffer.from([0x3c, 0x61, 0x3e, 0xe9, 0x3c, 0x2f, 0x61, 0x3e])

  test("uses the Content-Type charset", () => {
    expect(decode(latin, "application/rss+xml; charset=ISO-8859-1")).toBe(
      "<a>é</a>"
    )
  })

  test("the header wins over the prolog", () => {
    const bytes = Buffer.concat([
      Buffer.from('<?xml version="1.0" encoding="koi8-r"?>'),
      Buffer.from([0xe9]),
    ])
    expect(decode(bytes, 'text/xml; charset="iso-8859-1"')).toEndWith("é")
  })

  test("a BOM wins over the prolog", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('<?xml version="1.0" encoding="koi8-r"?><a>é</a>', "utf16le"),
    ])
    expect(decode(bytes, "text/xml")).toEndWith("<a>é</a>")
  })

  test("reads the prolog in single quotes", () => {
    const bytes = Buffer.concat([
      Buffer.from("<?xml version='1.0' encoding='windows-1251'?>"),
      Buffer.from([0xc4, 0xe0]),
    ])
    expect(decode(bytes, null)).toEndWith("Да")
  })

  test("falls back to UTF-8 with no charset anywhere", () => {
    expect(decode(Buffer.from("<a>ü</a>"), null)).toBe("<a>ü</a>")
  })

  test("an unknown label falls back to UTF-8", () => {
    expect(decode(Buffer.from("<a>ü</a>"), "text/xml; charset=x-bogus")).toBe(
      "<a>ü</a>"
    )
  })
})
