import { describe, expect, test } from "bun:test"

import { builtinSources } from "@/sources/builtin"
import { pluginFor, plugins } from "@/sources/index"
import type { SourcePlugin } from "@/sources/types"

import { canonicalUrl } from "./target"

// A parameterised plugin with several spellings per address, like the
// trending one to come: http or www, a trailing slash and a missing
// `since` all reach one URL; an unknown `since` is not its address.
const PAGE = "https://pages.example/list"
const paged: SourcePlugin = {
  id: "paged",
  canonical(url) {
    const host = url.hostname.replace(/^www\./, "")
    if (host !== "pages.example") return null
    if (url.pathname.replace(/\/$/, "") !== "/list") return null
    const since = url.searchParams.get("since") ?? "daily"
    if (!["daily", "weekly"].includes(since)) return null
    return `${PAGE}?since=${since}`
  },
  fetchEntries: async () => [],
}
const registry = { paged }

describe("canonicalUrl", () => {
  test("every spelling of a plugin address reaches one URL", () => {
    for (const spelling of [
      PAGE,
      `${PAGE}/`,
      "http://pages.example/list",
      "https://www.pages.example/list/?since=daily",
      `${PAGE}?since=daily#top`,
      `  ${PAGE}  `,
    ]) {
      expect(canonicalUrl(spelling, registry)).toBe(`${PAGE}?since=daily`)
    }
    expect(canonicalUrl(`${PAGE}?since=weekly&x=1`, registry)).toBe(
      `${PAGE}?since=weekly`
    )
  })

  test("is idempotent", () => {
    for (const input of [
      `${PAGE}/`,
      "http://www.pages.example/list?since=weekly",
      "https://cursor.com/blog",
      "https://example.com/feed.xml#x",
      "HTTPS://Example.COM/a/../feed",
    ]) {
      const once = canonicalUrl(input, { ...registry, ...plugins })
      expect(once).not.toBeNull()
      expect(canonicalUrl(once!, { ...registry, ...plugins })).toBe(once)
    }
  })

  test("leaves addresses no plugin owns as normalised URLs", () => {
    expect(canonicalUrl(`${PAGE}?since=yearly`, registry)).toBe(
      `${PAGE}?since=yearly`
    )
    expect(
      canonicalUrl("https://pages.example.evil.invalid/list", registry)
    ).toBe("https://pages.example.evil.invalid/list")
    expect(canonicalUrl("https://example.com/feed.xml#top", registry)).toBe(
      "https://example.com/feed.xml"
    )
    expect(canonicalUrl("http://example.com", registry)).toBe(
      "http://example.com/"
    )
  })

  test("keeps the cursor-blog address exact", () => {
    expect(canonicalUrl("https://cursor.com/blog")).toBe(
      "https://cursor.com/blog"
    )
    expect(canonicalUrl("https://cursor.com/blog/")).toBe(
      "https://cursor.com/blog/"
    )
    expect(canonicalUrl("http://cursor.com/blog")).toBe(
      "http://cursor.com/blog"
    )
  })

  test("each built-in url is its own canonical form", () => {
    for (const source of builtinSources) {
      expect(canonicalUrl(source.url)).toBe(source.url)
    }
  })

  test("refuses what is not an http(s) URL", () => {
    for (const input of [
      "",
      "not a url",
      "ftp://example.com/feed",
      "javascript:alert(1)",
    ]) {
      expect(canonicalUrl(input, registry)).toBeNull()
    }
  })
})

describe("pluginFor", () => {
  test("returns the plugin and its canonical URL", () => {
    expect(pluginFor("http://www.pages.example/list/", registry)).toEqual({
      plugin: paged,
      url: `${PAGE}?since=daily`,
    })
    expect(pluginFor(`${PAGE}?since=yearly`, registry)).toBeUndefined()
  })

  test("ignores prototype names", () => {
    const inherited = Object.create({ paged }) as Record<string, SourcePlugin>
    expect(pluginFor(PAGE, inherited)).toBeUndefined()
    expect(pluginFor("https://example.com/constructor", {})).toBeUndefined()
    expect(pluginFor("https://example.com/__proto__", {})).toBeUndefined()
  })
})
