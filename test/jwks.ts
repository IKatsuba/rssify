import { afterAll, beforeAll } from "bun:test"

import { auth } from "@/lib/auth"

const JWKS_URL = "http://localhost:3210/api/auth/jwks"

// requireMcpAuth fetches our own JWKS over HTTP. For the calling test file,
// that one URL is answered in process by auth.handler, and any other fetch
// throws, so a test that reaches for the network fails loudly.
export function answerJwksInProcess() {
  const realFetch = globalThis.fetch
  beforeAll(() => {
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const request = new Request(input, init)
      if (request.url === JWKS_URL) return auth.handler(request)
      throw new Error(`Test tried to fetch ${request.url}`)
    }) as typeof fetch
  })
  afterAll(() => {
    globalThis.fetch = realFetch
  })
}
