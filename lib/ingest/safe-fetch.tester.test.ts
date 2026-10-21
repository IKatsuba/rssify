import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import { createServer, type RequestListener, type Server } from "node:http"
import type { AddressInfo, LookupFunction } from "node:net"

import { createSafeFetch, isPublicAddress, safeFetch } from "./safe-fetch"

// Independent security regressions. DNS is always fake; sockets only reach
// this file's listener on 127.0.0.1 through the explicit test overrides.
const loopbackLookup = ((_host, _options, callback) => {
  callback(null, [{ address: "127.0.0.1", family: 4 }] as never)
}) as LookupFunction

let server: Server
let port: number
const requests: { host: string | undefined; url: string | undefined }[] = []
let respond: RequestListener = (_req, res) => res.end("<rss/>")

beforeEach(() => {
  respond = (_req, res) => res.end("<rss/>")
})

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ host: req.headers.host, url: req.url })
    respond(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})

describe("tester: response failures and redirect boundaries", () => {
  const at = (path: string) => `http://feed.test:${port}${path}`
  const fetch = (
    path: string,
    options?: Parameters<ReturnType<typeof createSafeFetch>>[1]
  ) =>
    createSafeFetch({
      lookup: loopbackLookup,
      ports: [port],
      allowAddress: (address) => address === "127.0.0.1",
    })(at(path), options)

  test.each([303, 307, 308])(
    "follows %i relative redirect and keeps GET",
    async (status) => {
      const methods: (string | undefined)[] = []
      respond = (req, res) => {
        methods.push(req.method)
        if (req.url === "/dir/start") {
          res.writeHead(status, { location: "../feed?from=redirect" })
          res.end()
        } else res.end('{"items":[]}')
      }
      expect(await fetch("/dir/start")).toMatchObject({
        status: 200,
        url: at("/feed?from=redirect"),
        text: '{"items":[]}',
        kind: "json",
      })
      expect(methods).toEqual(["GET", "GET"])
    }
  )

  test("deadline aborts a body after headers and a partial chunk", async () => {
    let received = false
    respond = (_req, res) => {
      received = true
      res.writeHead(200, { "content-type": "application/rss+xml" })
      res.write("<rss>")
      // Deliberately never finish; cancellation must stop the reader.
    }
    await expect(
      fetch("/stalled", { deadline: AbortSignal.timeout(200) })
    ).rejects.toMatchObject({
      code: "unreachable",
      message: "the server took too long",
    })
    expect(received).toBe(true)
  })

  test("an already aborted deadline cannot send a request", async () => {
    const before = requests.length
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetch("/cancelled", { deadline: controller.signal })
    ).rejects.toMatchObject({ code: "unreachable" })
    expect(requests.length).toBe(before)
  })

  test.each([304, 403, 404, 410, 429, 500])(
    "returns HTTP %i and headers without decoding its body",
    async (status) => {
      respond = (_req, res) => {
        res.writeHead(status, { "retry-after": "60", etag: '"unchanged"' })
        res.end("<html>not a feed</html>")
      }
      const result = await fetch("/status")
      expect(result).toMatchObject({ status, text: "", kind: "unknown" })
      expect(result.headers.get("retry-after")).toBe("60")
      expect(result.headers.get("etag")).toBe('"unchanged"')
    }
  )

  test("empty success remains a success with unknown body kind", async () => {
    respond = (_req, res) => res.end()
    expect(await fetch("/empty")).toMatchObject({
      status: 200,
      text: "",
      kind: "unknown",
    })
  })

  test("corrupt gzip response normalizes to unreachable", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip" })
      res.end("not gzip bytes")
    }
    await expect(fetch("/corrupt")).rejects.toMatchObject({
      code: "unreachable",
    })
  })

  test("Content-Type charset wins over a conflicting UTF-8 BOM", async () => {
    respond = (_req, res) => {
      res.writeHead(200, {
        "content-type": 'application/xml; charset="windows-1252"',
      })
      res.end(Buffer.from([0xef, 0xbb, 0xbf, 0xe9]))
    }
    expect((await fetch("/charset")).text).toBe("ï»¿é")
  })

  test("one decoded byte beyond the cap fails for multibyte text", async () => {
    const body = Buffer.from("é".repeat(5 * 1024 * 1024) + "!")
    respond = (_req, res) => res.end(body)
    expect(body.byteLength).toBe(10 * 1024 * 1024 + 1)
    await expect(fetch("/large")).rejects.toMatchObject({ code: "too_large" })
  })
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

describe("tester: strict guard defaults", () => {
  test.each([
    "http://127.1/",
    "http://0177.0.0.1/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[ff02::1]/",
  ])("default factories reject canonicalised or special IP %s", async (url) => {
    await expect(
      createSafeFetch({ lookup: loopbackLookup })(url)
    ).rejects.toMatchObject({ code: "blocked" })
  })

  test.each(["http://127.0.0.1/", "http://feed.test:8080/"])(
    "exported safeFetch rejects %s without a socket",
    async (url) => {
      await expect(safeFetch(url)).rejects.toMatchObject({ code: "blocked" })
    }
  )

  test("an address override alone does not permit a nonstandard port", async () => {
    const fetch = createSafeFetch({
      lookup: loopbackLookup,
      allowAddress: () => true,
    })
    await expect(fetch("http://feed.test:8080/")).rejects.toMatchObject({
      code: "blocked",
      message: "the port isn’t allowed",
    })
  })

  test("a port override alone does not permit a private DNS answer", async () => {
    const before = requests.length
    const fetch = createSafeFetch({ lookup: loopbackLookup, ports: [port] })
    await expect(fetch(`http://feed.test:${port}/`)).rejects.toMatchObject({
      code: "blocked",
    })
    expect(requests.length).toBe(before)
  })

  test.each(["http://user%40name@feed.test/", "http://:password@feed.test/"])(
    "encoded or password-only credentials are invalid: %s",
    async (url) => {
      await expect(
        createSafeFetch({ lookup: loopbackLookup })(url)
      ).rejects.toMatchObject({ code: "invalid_url" })
    }
  )

  test.each([
    "172.31.255.255",
    "192.168.255.255",
    "100.127.255.255",
    "198.18.0.1",
    "2001:db8::1",
    "ff02::1",
  ])("special range boundary %s is blocked", (address) =>
    expect(isPublicAddress(address)).toBe(false)
  )

  test("mapped public IPv4 is classified like its IPv4 form", () => {
    expect(isPublicAddress("::ffff:0808:0808")).toBe(true)
  })
})

describe("tester: local guarded transport", () => {
  test("accepts exactly 2048 URL characters and preserves Host and path", async () => {
    const prefix = `http://feed.test:${port}/`
    const url = prefix + "a".repeat(2048 - prefix.length)
    const fetch = createSafeFetch({
      lookup: loopbackLookup,
      ports: [port],
      allowAddress: (address) => address === "127.0.0.1",
    })
    const result = await fetch(url)
    expect(result).toMatchObject({
      status: 200,
      url,
      text: "<rss/>",
      kind: "xml",
    })
    expect(requests.at(-1)).toEqual({
      host: `feed.test:${port}`,
      url: new URL(url).pathname,
    })
    const before = requests.length
    await expect(fetch(url + "a")).rejects.toMatchObject({
      code: "invalid_url",
    })
    expect(requests.length).toBe(before)
  })
})
