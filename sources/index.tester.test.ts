import { describe, expect, test } from "bun:test"

import { builtinSource } from "./builtin"
import { pluginFor } from "./index"
import type { SourcePlugin } from "./types"

describe("source lookup tester edges", () => {
  test("built-in lookup requires the declared id and rejects object property names", () => {
    for (const id of [
      "",
      "Claude-Code",
      " claude-code ",
      "cursor-blog",
      "__proto__",
      "constructor",
      "toString",
    ]) {
      expect(builtinSource(id)).toBeUndefined()
    }
  })

  test("plugin selection is exact across multiple descriptors and never fetches", () => {
    let fetchCalls = 0
    const first: SourcePlugin = {
      id: "first",
      matches: "https://example.com/blog",
      fetchEntries: async () => {
        fetchCalls++
        throw new Error("lookup must not execute a plugin")
      },
    }
    const second: SourcePlugin = {
      ...first,
      id: "second",
      matches: "https://other.example/blog",
    }
    const registry = { first, second }
    expect(pluginFor(second.matches, registry)).toBe(second)
    expect(pluginFor(first.matches, registry)).toBe(first)
    for (const url of [
      "http://example.com/blog",
      "https://example.com/blog?feed=1",
      "https://example.com/blog#feed",
      "https://example.com/blogger",
      "https://example.com.evil.invalid/blog",
    ]) {
      expect(pluginFor(url, registry)).toBeUndefined()
    }
    expect(fetchCalls).toBe(0)
  })
})
