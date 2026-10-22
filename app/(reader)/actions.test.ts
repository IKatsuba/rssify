import { describe, expect, mock, test } from "bun:test"

// Outside Next there is no request; an empty one has no session cookie.
mock.module("next/headers", () => ({ headers: async () => new Headers() }))

const actions = await import("./actions")

async function redirectOf(call: () => Promise<unknown>) {
  try {
    await call()
  } catch (e) {
    return (e as { digest?: string }).digest
  }
  throw new Error("expected a redirect")
}

describe("reader actions without a session", () => {
  const calls: [string, () => Promise<unknown>][] = [
    ["subscribe", () => actions.subscribe({ url: "https://example.com" })],
    ["subscribe a source", () => actions.subscribe({ source: "claude-code" })],
    ["unsubscribe", () => actions.unsubscribe("f1")],
    ["markRead", () => actions.markRead("e1")],
    ["markUnread", () => actions.markUnread("e1")],
    ["markAllRead", () => actions.markAllRead({ upTo: new Date() })],
    [
      "markAllRead with junk",
      () => actions.markAllRead({ feedId: "f1", upTo: "nope" }),
    ],
    ["createApiKey", () => actions.createApiKey("Reader app")],
    ["createApiKey with junk", () => actions.createApiKey("")],
    ["revokeApiKey", () => actions.revokeApiKey("k1")],
  ]
  for (const [name, call] of calls) {
    test(`${name} redirects to /sign-in`, async () => {
      expect(await redirectOf(call)).toStartWith(
        "NEXT_REDIRECT;replace;/sign-in;"
      )
    })
  }
})
