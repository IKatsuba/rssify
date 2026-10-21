import { lookup as dnsLookup } from "node:dns"
import { isIP, type LookupFunction } from "node:net"

import ipaddr from "ipaddr.js"
// The subpath, not "undici": Bun maps the bare name to its built-in shim,
// which ignores a custom Agent connect, so the guard would never run.
import { Agent, buildConnector, fetch } from "undici/index.js"

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

function sniff(text: string): SafeFetchResult["kind"] {
  const first = text.replace(/^﻿/, "").trimStart()[0]
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

  return async (input, { deadline = AbortSignal.timeout(15_000) } = {}) => {
    const url = checkUrl(input, guard)
    let response
    try {
      response = await fetch(url, {
        dispatcher,
        redirect: "manual",
        signal: deadline,
      })
    } catch (error) {
      throw (
        findSafeFetchError(error) ??
        new SafeFetchError("unreachable", "the server couldn’t be reached")
      )
    }
    const ok = response.status >= 200 && response.status < 300
    let text = ""
    if (ok) text = await response.text()
    else await response.body?.cancel()
    return {
      status: response.status,
      url: url.href,
      headers: response.headers as unknown as Headers,
      text,
      kind: ok ? sniff(text) : "unknown",
    }
  }
}

export const safeFetch = createSafeFetch({ lookup: dnsLookup })
