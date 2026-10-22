import { describe, expect, test } from "bun:test"

import { anthropicEngineering, anthropicNews } from "./anthropic"
import { builtinSource, builtinSources } from "./builtin"
import { bytes } from "./bytes"
import { cursorBlog } from "./cursor-blog"
import { githubTrending } from "./github-trending"
import { pluginFor, plugins } from "./index"
import type { SourcePlugin } from "./types"

const fake: SourcePlugin = {
  id: "fake",
  canonical: (url) =>
    url.href === "https://example.com/blog" ? "https://example.com/blog" : null,
  fetchEntries: async () => [],
}

describe("builtinSources", () => {
  test("lists the built-in sources ordered by title", () => {
    expect(builtinSources.map((s) => s.id)).toEqual([
      "anthropic-engineering",
      "anthropic-news",
      "claude-code",
      "cursor-blog",
      "langchain-blog",
      "nodejs-blog",
    ])
    const titles = builtinSources.map((s) => s.title)
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)))
    expect(builtinSource("anthropic-engineering")?.url).toBe(
      "https://www.anthropic.com/engineering"
    )
    expect(builtinSource("anthropic-news")?.url).toBe(
      "https://www.anthropic.com/news"
    )
    expect(builtinSource("claude-code")?.url).toBe("https://claude.dev/rss.xml")
    expect(builtinSource("cursor-blog")?.url).toBe("https://cursor.com/blog")
    expect(builtinSource("langchain-blog")?.url).toBe(
      "https://www.langchain.com/blog/rss.xml"
    )
    expect(builtinSource("nodejs-blog")?.url).toBe(
      "https://nodejs.org/en/feed/blog.xml"
    )
    expect(builtinSource("nope")).toBeUndefined()
  })
})

describe("pluginFor", () => {
  test("the registered plugins", () => {
    expect(plugins).toEqual({
      "anthropic-engineering": anthropicEngineering,
      "anthropic-news": anthropicNews,
      bytes,
      "cursor-blog": cursorBlog,
      "github-trending": githubTrending,
    })
    expect(pluginFor("https://cursor.com/blog")).toEqual({
      plugin: cursorBlog,
      url: "https://cursor.com/blog",
    })
    expect(pluginFor("https://claude.dev/rss.xml")).toBeUndefined()
  })

  test("matches the exact URL only", () => {
    const registry = { fake }
    expect(pluginFor("https://example.com/blog", registry)?.plugin).toBe(fake)
    expect(pluginFor("https://example.com/blog/", registry)).toBeUndefined()
    expect(pluginFor("https://example.com/blog/post", registry)).toBeUndefined()
  })
})
