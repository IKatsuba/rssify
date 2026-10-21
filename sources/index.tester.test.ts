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
      "__proto__",
      "constructor",
      "toString",
    ]) {
      expect(builtinSource(id)).toBeUndefined()
    }
  })

  test("registered Cursor descriptor selects only its exact list URL", () => {
    const source = builtinSource("cursor-blog")
    expect(source).toMatchObject({
      id: "cursor-blog",
      title: "Cursor blog",
      url: "https://cursor.com/blog",
      note: "No feed of its own",
    })
    expect(pluginFor(source!.url)?.id).toBe(source!.id)
    for (const url of [
      "https://cursor.com/blog/",
      "https://cursor.com/blog/projects",
      "https://cursor.com/blog?ref=feed",
      "https://cursor.com/blog#posts",
      "https://cursor.com.evil.invalid/blog",
      "http://cursor.com/blog",
    ]) {
      expect(pluginFor(url)).toBeUndefined()
    }
    expect(builtinSource("Cursor-blog")).toBeUndefined()
    expect(builtinSource(" cursor-blog ")).toBeUndefined()
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
