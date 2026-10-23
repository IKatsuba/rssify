import { describe, expect, test } from "bun:test"

import { addFeedError } from "./add-feed-errors"

describe("addFeedError", () => {
  test("one sentence per code", () => {
    const url = "https://example.com/blog"
    expect(addFeedError("invalid_url", "nope")).toBe(
      "That doesn’t look like a web address."
    )
    expect(addFeedError("blocked", url)).toBe(
      "That address can’t be fetched from here."
    )
    expect(addFeedError("not_found", url)).toBe(
      "We couldn’t find a feed at that address. Try the site’s feed URL directly."
    )
    expect(addFeedError("too_large", url)).toBe(
      "That feed is too large to read (over 10 MB)."
    )
    expect(addFeedError("limit", url)).toBe(
      "You follow 500 feeds, the most rssify allows. Unsubscribe from one first."
    )
  })

  test("{host} is the typed address's host, port included", () => {
    expect(addFeedError("unreachable", " https://example.com:8080/x ")).toBe(
      "We couldn’t reach example.com:8080. Check the address and try again."
    )
    expect(addFeedError("multiple", "https://www.example.com/")).toBe(
      "www.example.com has more than one feed. Pick one."
    )
  })

  test("an address that does not parse is named as typed", () => {
    expect(addFeedError("unreachable", " example ")).toBe(
      "We couldn’t reach example. Check the address and try again."
    )
  })

  test("any other code falls back", () => {
    expect(addFeedError("rate_limited", "https://example.com")).toBe(
      "We couldn’t add that feed. Try again."
    )
  })
})
