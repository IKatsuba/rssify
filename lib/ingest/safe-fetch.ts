import { lookup as dnsLookup } from "node:dns"
import { isIP, type LookupFunction } from "node:net"

import ipaddr from "ipaddr.js"
// The subpath, not "undici": Bun maps the bare name to its built-in shim,
// which ignores a custom Agent connect, so the guard would never run.
import { Agent, buildConnector, fetch, type Response } from "undici/index.js"

export type SafeFetchErrorCode =
  "invalid_url" | "blocked" | "unreachable" | "too_large"

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string
  ) {
    super(message)
    this.name = "SafeFetchError"
  }
}

export type SafeFetchOptions = {
  etag?: string | null
  lastModified?: string | null
  deadline?: AbortSignal
}

export type SafeFetchResult = {
  status: number
  url: string
  headers: Headers
  text: string
  kind: "json" | "xml" | "unknown"
}

export type SafeFetch = (
  url: string,
  options?: SafeFetchOptions
) => Promise<SafeFetchResult>

const MAX_URL_LENGTH = 2048
const DEFAULT_PORTS = [80, 443]

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false
  let parsed = ipaddr.parse(address)
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6
    if (v6.isIPv4MappedAddress()) parsed = v6.toIPv4Address()
  }
  return parsed.range() === "unicast"
}

type Guard = {
  allowAddress: (address: string) => boolean
  ports: readonly number[]
}

// Checked on every hop, before anything connects.
function checkUrl(input: string, guard: Guard): URL {
  if (input.length > MAX_URL_LENGTH) {
    throw new SafeFetchError("invalid_url", "the address is too long")
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new SafeFetchError("invalid_url", "the address isn’t valid")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("invalid_url", "only http and https are allowed")
  }
  if (url.username || url.password) {
    throw new SafeFetchError("invalid_url", "credentials aren’t allowed")
  }
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80
  if (!guard.ports.includes(port)) {
    throw new SafeFetchError("blocked", "the port isn’t allowed")
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1")
  if (isIP(host) && !guard.allowAddress(host)) {
    throw new SafeFetchError("blocked", "the address isn’t allowed")
  }
  return url
}

function guardedAgent(lookup: LookupFunction, guard: Guard): Agent {
  // Every address must pass, not just the one picked: the socket may try
  // any of them (happy eyeballs), and a rebinding answer mixes them.
  const guardedLookup = ((hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0)
      const list = addresses as unknown as { address: string; family: number }[]
      if (
        list.length === 0 ||
        !list.every((a) => guard.allowAddress(a.address))
      ) {
        return callback(
          new SafeFetchError("blocked", "the address isn’t allowed"),
          "",
          0
        )
      }
      if (options.all) return callback(null, list as never)
      callback(null, list[0].address, list[0].family)
    })
  }) as LookupFunction

  // The URL keeps the hostname, so TLS still uses it as servername and the
  // certificate check is unchanged; only the address comes from our lookup.
  const connector = buildConnector({ lookup: guardedLookup } as never)
  return new Agent({
    connect: (options, callback) =>
      connector(options, (err, socket) => {
        if (err || !socket) return callback(err, null)
        // Defence in depth: the address the socket actually reached.
        const remote = socket.remoteAddress
        if (!remote || !guard.allowAddress(remote)) {
          socket.destroy()
          return callback(
            new SafeFetchError("blocked", "the address isn’t allowed"),
            null
          )
        }
        callback(null, socket)
      }),
  })
}

function findSafeFetchError(error: unknown): SafeFetchError | null {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (e instanceof SafeFetchError) return e
  }
  return null
}

const MAX_REDIRECTS = 5
const MAX_BYTES = 10 * 1024 * 1024
const REDIRECTS = new Set([301, 302, 303, 307, 308])

const HEADERS = {
  "user-agent": "rssify/1.0 (+https://github.com/IKatsuba/rssify)",
  accept:
    "application/feed+json, application/atom+xml, application/rss+xml, " +
    "application/rdf+xml, application/xml;q=0.9, text/xml;q=0.9, " +
    "text/html;q=0.8, */*;q=0.5",
}

// undici has already undone any Content-Encoding, so this counts decoded
// bytes; the cap stops reading rather than trusting Content-Length.
async function readCapped(body: NonNullable<Response["body"]>) {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return Buffer.concat(chunks)
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {})
      throw new SafeFetchError("too_large", "the response is over 10 MB")
    }
    chunks.push(value)
  }
}

function bomCharset(bytes: Uint8Array) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8"
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be"
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le"
  return null
}

// response.text() would always use UTF-8; feeds such as koi8-r ones declare
// their charset only in the prolog. The header wins, as RFC 7303 says.
export function decode(bytes: Uint8Array, contentType: string | null) {
  const charset =
    contentType?.match(/charset\s*=\s*"?([^";\s]+)/i)?.[1] ??
    bomCharset(bytes) ??
    new TextDecoder("latin1")
      .decode(bytes.subarray(0, 1024))
      .match(/^\s*<\?xml[^>]*?\sencoding\s*=\s*["']([^"']+)["']/)?.[1] ??
    "utf-8"
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(charset)
  } catch {
    decoder = new TextDecoder("utf-8")
  }
  return decoder.decode(bytes)
}

function sniff(text: string): SafeFetchResult["kind"] {
  // trimStart also drops a BOM the decoder left in.
  const first = text.trimStart()[0]
  return first === "{" ? "json" : first === "<" ? "xml" : "unknown"
}

// allowAddress and ports are for tests only, which reach a 127.0.0.1
// listener through them; safeFetch below passes neither.
export function createSafeFetch({
  lookup,
  allowAddress = isPublicAddress,
  ports = DEFAULT_PORTS,
}: {
  lookup: LookupFunction
  allowAddress?: (address: string) => boolean
  ports?: readonly number[]
}): SafeFetch {
  const guard = { allowAddress, ports }
  const dispatcher = guardedAgent(lookup, guard)

  return async (
    input,
    { etag, lastModified, deadline = AbortSignal.timeout(15_000) } = {}
  ) => {
    const headers: Record<string, string> = { ...HEADERS }
    if (etag) headers["if-none-match"] = etag
    if (lastModified) headers["if-modified-since"] = lastModified

    try {
      let target = input
      for (let hop = 0; ; hop++) {
        const url = checkUrl(target, guard)
        const response = await fetch(url, {
          dispatcher,
          headers,
          redirect: "manual",
          signal: deadline,
        })

        if (REDIRECTS.has(response.status)) {
          await response.body?.cancel()
          if (hop === MAX_REDIRECTS) {
            throw new SafeFetchError("unreachable", "too many redirects")
          }
          const location = response.headers.get("location")
          if (!location) {
            throw new SafeFetchError("invalid_url", "a redirect had no address")
          }
          try {
            target = new URL(location, url).href
          } catch {
            throw new SafeFetchError(
              "invalid_url",
              "a redirect address isn’t valid"
            )
          }
          continue
        }

        const ok = response.status >= 200 && response.status < 300
        let text = ""
        if (ok && response.body) {
          const bytes = await readCapped(response.body)
          text = decode(bytes, response.headers.get("content-type"))
        } else {
          await response.body?.cancel()
        }
        return {
          status: response.status,
          url: url.href,
          headers: response.headers as unknown as Headers,
          text,
          kind: ok ? sniff(text) : "unknown",
        }
      }
    } catch (error) {
      throw (
        findSafeFetchError(error) ??
        new SafeFetchError(
          "unreachable",
          deadline.aborted
            ? "the server took too long"
            : "the server couldn’t be reached"
        )
      )
    }
  }
}

export const safeFetch = createSafeFetch({ lookup: dnsLookup })
