import { describe, expect, test } from "bun:test"

import { builtinSource, builtinSources } from "./builtin"
import { cursorBlog } from "./cursor-blog"
import { pluginFor, plugins } from "./index"
import type { SourcePlugin } from "./types"

const fake: SourcePlugin = {
  id: "fake",
  matches: "https://example.com/blog",
  fetchEntries: async () => [],
}

describe("builtinSources", () => {
  test("holds the Claude Code feed and the Cursor blog page", () => {
    expect(builtinSources.map((s) => s.id)).toEqual([
      "claude-code",
      "cursor-blog",
    ])
    expect(builtinSource("claude-code")?.url).toBe("https://claude.dev/rss.xml")
    expect(builtinSource("cursor-blog")?.url).toBe("https://cursor.com/blog")
    expect(builtinSource("nope")).toBeUndefined()
  })
})

describe("pluginFor", () => {
  test("cursor-blog is the one registered plugin", () => {
    expect(plugins).toEqual({ "cursor-blog": cursorBlog })
    expect(pluginFor("https://cursor.com/blog")).toBe(cursorBlog)
    expect(pluginFor("https://claude.dev/rss.xml")).toBeUndefined()
  })

  test("matches the exact URL only", () => {
    const registry = { fake }
    expect(pluginFor("https://example.com/blog", registry)).toBe(fake)
    expect(pluginFor("https://example.com/blog/", registry)).toBeUndefined()
    expect(pluginFor("https://example.com/blog/post", registry)).toBeUndefined()
  })
})
