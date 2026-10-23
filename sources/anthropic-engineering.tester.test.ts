import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { SafeFetchError, type SafeFetch } from "@/lib/ingest/safe-fetch"

import { anthropicEngineering } from "./anthropic"
import { SourceStatusError } from "./types"

const LIST = "https://www.anthropic.com/engineering"
const POST = "https://www.anthropic.com/research/example"
const savedList = readFileSync(
  join(import.meta.dir, "../test/fixtures/anthropic-engineering/list.html"),
  "utf8"
)
const card = (url = POST) =>
  `<article><time>Feb 29, 2024</time><h3><a href="${url}">Post</a></h3></article>`
const body =
  '<meta property="og:title" content="Example"><div><p class="post-text">Body</p></div>'

function run(fetch: SafeFetch, known = new Set<string>()) {
  return anthropicEngineering.fetchEntries({
    url: LIST,
    fetch,
    known: async () => known,
    deadline: new AbortController().signal,
  })
}

function answer(url: string, text: string, status = 200) {
  return { url, text, status, headers: new Headers(), kind: "unknown" as const }
}

describe("Anthropic engineering tester regressions", () => {
  test.each([304, 404, 429, 500])(
    "list HTTP %i preserves status and headers",
    async (status) => {
      const headers = new Headers({ "Retry-After": "120" })
      try {
        await run(async (url) => ({ ...answer(url, "", status), headers }))
        throw new Error("Expected list failure")
      } catch (error) {
        expect(error).toBeInstanceOf(SourceStatusError)
        expect((error as SourceStatusError).status).toBe(status)
        expect((error as SourceStatusError).headers.get("Retry-After")).toBe(
          "120"
        )
      }
    }
  )

  test("synthetic list backfill fetches ten posts and forwards the deadline", async () => {
    const calls: string[] = []
    const deadline = new AbortController().signal
    const entries = await anthropicEngineering.fetchEntries({
      url: LIST,
      known: async () => new Set(),
      deadline,
      fetch: async (url, options) => {
        expect(options?.deadline).toBe(deadline)
        calls.push(url)
        return answer(url, url === LIST ? savedList : body)
      },
    })
    expect(calls).toHaveLength(11)
    expect(entries).toHaveLength(10)
    expect(entries.map((entry) => entry.guid)).toEqual(calls.slice(1))
  })

  test("repeated spellings produce one fetch; known posts produce none", async () => {
    const calls: string[] = []
    const fetch: SafeFetch = async (url) => {
      calls.push(url)
      return answer(
        url,
        url === LIST ? card(`${POST}?ref=a#top`) + card(POST) : body
      )
    }
    expect(await run(fetch)).toHaveLength(1)
    expect(calls).toEqual([LIST, POST])
    calls.length = 0
    expect(await run(fetch, new Set([POST]))).toEqual([])
    expect(calls).toEqual([LIST])
  })

  test.each([304, 404, 429, 500])(
    "all posts HTTP %i fail rather than returning empty success",
    async (status) => {
      await expect(
        run(async (url) =>
          answer(url, url === LIST ? card() : "", url === LIST ? 200 : status)
        )
      ).rejects.toThrow("none of the new posts could be read")
    }
  )

  test("a failed post does not discard a readable sibling", async () => {
    const entries = await run(async (url) => {
      if (url === LIST) return answer(url, card(`${POST}-bad`) + card())
      if (url.endsWith("-bad")) throw new SafeFetchError("unreachable", "timed out")
      return answer(url, body)
    })
    expect(entries.map((entry) => entry.guid)).toEqual([POST])
  })

  test("invalid post date falls back to leap-day list date and sanitises the body", async () => {
    const entries = await run(async (url) =>
      answer(
        url,
        url === LIST
          ? card()
          : '<meta property="article:published_time" content="invalid">' +
              '<div><p class="post-text">Body <a href="/docs">Docs</a></p><script>alert(1)</script><img src="/image.png" onerror="bad()"></div>'
      )
    )
    expect(entries[0].publishedAt).toEqual(new Date("2024-02-29T00:00:00.000Z"))
    expect(entries[0].contentHtml).toContain(
      'href="https://www.anthropic.com/docs"'
    )
    expect(entries[0].contentHtml).not.toContain("<script")
    expect(entries[0].contentHtml).not.toContain("onerror")
  })
})
