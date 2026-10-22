import { readFileSync } from "node:fs"

import { describe, expect, test } from "bun:test"

import { SafeFetchError, type SafeFetch } from "@/lib/ingest/safe-fetch"

import { firefoxReleases } from "./firefox-releases"
import { SourceStatusError } from "./types"

const LIST = "https://www.firefox.com/en-US/releases/"
const notes = (version: string) =>
  `https://www.firefox.com/firefox/${version}/releasenotes/`
const savedList = readFileSync(
  "test/fixtures/firefox-releases/releases.html",
  "utf8"
)
const savedPost = readFileSync(
  "test/fixtures/firefox-releases/158.0.html",
  "utf8"
)
const answer = (url: string, text: string, status = 200) => ({
  url,
  text,
  status,
  headers: new Headers(),
  kind: "unknown" as const,
})
const link = (version: string) => `<a href="${notes(version)}">${version}</a>`
function run(fetch: SafeFetch) {
  return firefoxReleases.fetchEntries({
    url: LIST,
    fetch,
    known: async () => new Set(),
    deadline: new AbortController().signal,
  })
}

describe("Firefox tester regressions", () => {
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

  test.each([304, 404, 429, 500])(
    "all notes HTTP %i fail rather than empty success",
    async (status) => {
      await expect(
        run(async (url) =>
          answer(
            url,
            url === LIST ? link("158.0") : "",
            url === LIST ? 200 : status
          )
        )
      ).rejects.toThrow("none of the new posts could be read")
    }
  )

  test("empty or ESR-only list is a layout failure", async () => {
    for (const html of ["", link("153.0esr") + link("153.1.0")]) {
      await expect(run(async (url) => answer(url, html))).rejects.toThrow(
        "the page layout changed"
      )
    }
  })

  test("malformed release date retains readable notes with a null date", async () => {
    const entries = await run(async (url) =>
      answer(
        url,
        url === LIST
          ? link("158.0")
          : '<p class="c-release-date">February 30, 2026</p><div class="c-release-notes"><p>Readable notes</p></div>'
      )
    )
    expect(entries[0]).toMatchObject({
      title: "Firefox 158.0",
      publishedAt: null,
      contentHtml: "<p>Readable notes</p>",
    })
  })

  test("redirected responses retain original release identity and forward deadline", async () => {
    const deadline = new AbortController().signal
    const calls: string[] = []
    const entries = await firefoxReleases.fetchEntries({
      url: LIST,
      deadline,
      known: async () => new Set(),
      fetch: async (url, options) => {
        calls.push(url)
        expect(options?.deadline).toBe(deadline)
        return answer(
          url === LIST
            ? LIST
            : "https://www.firefox.com/en-US/firefox/158.0/releasenotes/",
          url === LIST ? link("158.0") : savedPost
        )
      },
    })
    expect(calls).toEqual([LIST, notes("158.0")])
    expect(entries[0]).toMatchObject({
      guid: notes("158.0"),
      url: notes("158.0"),
      title: "Firefox 158.0",
    })
  })

  test("saved archive takes ten releases then an all-known run requests only the list", async () => {
    const calls: string[] = []
    const fetch: SafeFetch = async (url) => {
      calls.push(url)
      return answer(url, url === LIST ? savedList : savedPost)
    }
    const entries = await run(fetch)
    expect(calls).toHaveLength(11)
    expect(new Set(entries.map((entry) => entry.guid)).size).toBe(10)
    calls.length = 0
    expect(
      await firefoxReleases.fetchEntries({
        url: LIST,
        fetch,
        known: async (urls) => new Set(urls),
        deadline: new AbortController().signal,
      })
    ).toEqual([])
    expect(calls).toEqual([LIST])
  })

  test("a timed-out release does not discard a readable sibling", async () => {
    const entries = await run(async (url) => {
      if (url === LIST) return answer(url, link("158.0") + link("158.0.1"))
      if (url === notes("158.0"))
        throw new SafeFetchError("unreachable", "timed out")
      return answer(url, savedPost)
    })
    expect(entries.map((entry) => entry.guid)).toEqual([notes("158.0.1")])
  })

  test("known lookup DB error propagates without fetching posts", async () => {
    const calls: string[] = []
    await expect(
      firefoxReleases.fetchEntries({
        url: LIST,
        deadline: new AbortController().signal,
        fetch: async (url) => {
          calls.push(url)
          return answer(url, savedList)
        },
        known: async () => {
          throw new Error("database unavailable")
        },
      })
    ).rejects.toThrow("database unavailable")
    expect(calls).toEqual([LIST])
  })
})
