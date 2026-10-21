import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
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

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ host: req.headers.host, url: req.url })
    res.end("<rss/>")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
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
