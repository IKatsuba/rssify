import { describe, expect, test } from "bun:test"

import { builtinSource, builtinSources } from "./builtin"
import { pluginFor, plugins } from "./index"
import type { SourcePlugin } from "./types"

const fake: SourcePlugin = {
  id: "fake",
  matches: "https://example.com/blog",
  fetchEntries: async () => [],
}

describe("builtinSources", () => {
  test("holds the Claude Code blog as a plain feed", () => {
    expect(builtinSources.map((s) => s.id)).toEqual(["claude-code"])
    expect(builtinSource("claude-code")?.url).toBe("https://claude.dev/rss.xml")
    expect(builtinSource("nope")).toBeUndefined()
  })
})

describe("pluginFor", () => {
  test("no plugin is registered yet", () => {
    expect(plugins).toEqual({})
    expect(pluginFor("https://claude.dev/rss.xml")).toBeUndefined()
  })

  test("matches the exact URL only", () => {
    const registry = { fake }
    expect(pluginFor("https://example.com/blog", registry)).toBe(fake)
    expect(pluginFor("https://example.com/blog/", registry)).toBeUndefined()
    expect(pluginFor("https://example.com/blog/post", registry)).toBeUndefined()
  })
})
