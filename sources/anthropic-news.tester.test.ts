import { describe, expect, test } from "bun:test"

import type { SafeFetch } from "@/lib/ingest/safe-fetch"

import { anthropicNews } from "./anthropic"

const ORIGIN = "https://www.anthropic.com"
const LIST = `${ORIGIN}/news`
const page =
  '<meta property="og:title" content="Launch"><meta name="description" content="Summary">'
const tile = (href: string, date: string) =>
  `<section><a class="FeaturedGrid-new__tileLink" href="${href}">Launch</a>${date ? `<time>${date}</time>` : ""}</section>`

async function read(list: string, post = page) {
  const calls: string[] = []
  const fetch: SafeFetch = async (url) => {
    calls.push(url)
    return {
      url,
      text: url === LIST ? list : post,
      status: 200,
      headers: new Headers(),
      kind: "unknown",
    }
  }
  const entries = await anthropicNews.fetchEntries({
    url: LIST,
    fetch,
    known: async () => new Set(),
    deadline: new AbortController().signal,
  })
  return { entries, calls }
}

describe("Anthropic news tester regressions", () => {
  test.each([
    ["Launch &amp; tools | Anthropic", "Launch & tools"],
    ["Launch | Anthropic | Extra", "Launch | Anthropic | Extra"],
    ["Launch | anthropic", "Launch | anthropic"],
  ])("title suffix handling preserves other text: %s", async (input, title) => {
    const { entries } = await read(
      tile("/launch", "Oct 1, 2026"),
      `<meta property="og:title" content="${input}"><meta name="description" content="Summary | Anthropic">`
    )
    expect(entries[0].title).toBe(title)
    expect(entries[0].summary).toBe("Summary | Anthropic")
  })

  test("launch and feature URLs deduplicate query/hash spellings and exclude external links", async () => {
    const { entries, calls } = await read(
      tile("/launch?ref=home#top", "Oct 1, 2026") +
        tile("/launch", "Oct 2, 2026") +
        tile("/features/example", "Oct 3, 2026") +
        tile(
          "https://www.anthropic.com.evil.invalid/news/post",
          "Oct 4, 2026"
        ) +
        '<a class="topic" href="/news/policy">Policy</a>'
    )
    expect(calls).toEqual([
      LIST,
      `${ORIGIN}/launch`,
      `${ORIGIN}/features/example`,
    ])
    expect(entries.map((entry) => entry.guid)).toEqual(calls.slice(1))
    expect(entries[0].publishedAt).toEqual(new Date("2026-10-01T00:00:00.000Z"))
  })

  test("a post published time wins over the tile date", async () => {
    const { entries } = await read(
      tile("/launch", "Oct 1, 2026"),
      page +
        '<meta property="article:published_time" content="2026-10-02T12:34:56Z">'
    )
    expect(entries[0].publishedAt).toEqual(new Date("2026-10-02T12:34:56Z"))
  })

  test("a malformed tile date stays null in a summary-only entry", async () => {
    const { entries } = await read(tile("/features/example", "Feb 30, 2026"))
    expect(entries[0]).toMatchObject({
      publishedAt: null,
      summary: "Summary",
      contentHtml: "Summary",
    })
  })

  test("an undated tile does not inherit a sibling tile's date", async () => {
    const { entries } = await read(
      `<main>${tile("/dated", "Oct 1, 2026")}${tile("/undated", "")}</main>`
    )
    expect(entries[0].publishedAt).toEqual(new Date("2026-10-01T00:00:00.000Z"))
    expect(entries[1].publishedAt).toBeNull()
  })

  test("empty and topic-only lists report layout change", async () => {
    for (const list of ["", '<a href="/news/policy">Policy</a>']) {
      await expect(read(list)).rejects.toThrow("the page layout changed")
    }
  })
})
