import { describe, expect, test } from "bun:test"

import type { SourcePlugin } from "@/sources/types"

import { fetchForAdd } from "./add"
import { normaliseEntry } from "./parse"
import type { SafeFetch } from "./safe-fetch"

const PAGE = "https://cursor.com/blog"
const noFetch: SafeFetch = async () => {
  throw new Error("unexpected network request")
}
const entry = normaliseEntry({ id: "post", title: "Post" }, PAGE)

const plugin = (overrides: Partial<SourcePlugin> = {}): SourcePlugin => ({
  id: "test-owner",
  canonical: (url) => (url.href.replace(/\/$/, "") === PAGE ? PAGE : null),
  fetchEntries: async () => [entry],
  ...overrides,
})

describe("plugin add tester contract", () => {
  test("built-in title wins lazily for an alias canonicalised to its URL", async () => {
    const seen: string[] = []
    const owner = plugin({
      title: () => {
        throw new Error("built-in title should win")
      },
      fetchEntries: async (ctx) => {
        seen.push(ctx.url)
        expect(await ctx.known([entry.guid])).toEqual(new Set())
        expect(ctx.fetch).toBe(noFetch)
        expect(ctx.deadline.aborted).toBe(false)
        return [entry]
      },
    })
    expect(
      await fetchForAdd(`${PAGE}/`, { plugins: { owner }, fetch: noFetch })
    ).toMatchObject({
      kind: "feed",
      feed: {
        title: "Cursor blog",
        siteUrl: PAGE,
        pluginId: owner.id,
        etag: null,
        lastModified: null,
      },
    })
    expect(seen).toEqual([PAGE])
  })

  test("an empty add fails before evaluating its optional title", async () => {
    const owner = plugin({
      title: () => {
        throw new Error("empty feeds have no title to evaluate")
      },
      fetchEntries: async () => [],
    })
    expect(
      await fetchForAdd(PAGE, { plugins: { owner }, fetch: noFetch })
    ).toEqual({ kind: "error", code: "not_found" })
  })
})
