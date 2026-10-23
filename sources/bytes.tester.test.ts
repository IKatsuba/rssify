import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { SafeFetchError, type SafeFetch } from "@/lib/ingest/safe-fetch"

import { bytes } from "./bytes"
import { SourceStatusError } from "./types"

const LIST = "https://bytes.dev/archives"
const POST = `${LIST}/531`
const savedList = readFileSync(
  join(import.meta.dir, "../test/fixtures/bytes/archives.html"),
  "utf8"
)
const savedPost = readFileSync(
  join(import.meta.dir, "../test/fixtures/bytes/531.html"),
  "utf8"
)
const card = (date: string, url = "/archives/531") =>
  `<a href="${url}"><span>${date}</span></a>`
const answer = (url: string, text: string, status = 200) => ({
  url,
  text,
  status,
  headers: new Headers(),
  kind: "unknown" as const,
})

function run(fetch: SafeFetch, known = new Set<string>()) {
  return bytes.fetchEntries({
    url: LIST,
    fetch,
    known: async () => known,
    deadline: new AbortController().signal,
  })
}

describe("Bytes tester regressions", () => {
  test.each([
    `${LIST}?`,
    `${LIST}#`,
    "https://www.bytes.dev:8443/archives/",
    "https://user:password@bytes.dev/archives",
    "https://bytes.dev/Archives",
  ])("rejects unsupported spelling %s", (url) => {
    expect(bytes.canonical(new URL(url))).toBeNull()
  })

  test.each(["2/29/2026", "4/31/2026", "10/0/2026", "10/20/2026 extra", ""])(
    "malformed card date %s stays null through issue ingestion",
    async (date) => {
      const entries = await run(async (url) =>
        answer(url, url === LIST ? card(date) : savedPost)
      )
      expect(entries).toHaveLength(1)
      expect(entries[0].publishedAt).toBeNull()
      expect(entries[0].guid).toBe(POST)
    }
  )

  test("leap-day card date is UTC midnight through issue ingestion", async () => {
    const entries = await run(async (url) =>
      answer(url, url === LIST ? card("2/29/2024") : savedPost)
    )
    expect(entries[0].publishedAt).toEqual(new Date("2024-02-29T00:00:00.000Z"))
  })

  test.each([304, 404, 429, 500])(
    "all issue responses HTTP %i fail rather than returning empty success",
    async (status) => {
      await expect(
        run(async (url) =>
          answer(
            url,
            url === LIST ? card("10/20/2026") : "",
            url === LIST ? 200 : status
          )
        )
      ).rejects.toThrow("none of the new posts could be read")
    }
  )

  test.each([304, 404, 429, 500])(
    "archive HTTP %i preserves status and Retry-After",
    async (status) => {
      const headers = new Headers({ "Retry-After": "120" })
      try {
        await run(async (url) => ({ ...answer(url, "", status), headers }))
        throw new Error("Expected archive failure")
      } catch (error) {
        expect(error).toBeInstanceOf(SourceStatusError)
        expect((error as SourceStatusError).status).toBe(status)
        expect((error as SourceStatusError).headers.get("Retry-After")).toBe(
          "120"
        )
      }
    }
  )

  test("an archive containing only non-numeric links reports layout changed", async () => {
    const calls: string[] = []
    await expect(
      run(async (url) => {
        calls.push(url)
        return answer(url, card("10/20/2026", "/archives/latest"))
      })
    ).rejects.toThrow("the page layout changed")
    expect(calls).toEqual([LIST])
  })

  test("synthetic archive fetches ten issues, forwards deadline, then skips known issues", async () => {
    const calls: string[] = []
    const deadline = new AbortController().signal
    const fetch: SafeFetch = async (url, options) => {
      expect(options?.deadline).toBe(deadline)
      calls.push(url)
      return answer(url, url === LIST ? savedList : savedPost)
    }
    const ctx = {
      url: LIST,
      fetch,
      deadline,
      known: async () => new Set<string>(),
    }
    const entries = await bytes.fetchEntries(ctx)
    expect(calls).toHaveLength(11)
    expect(entries.map((entry) => entry.guid)).toEqual(calls.slice(1))
    calls.length = 0
    expect(
      await bytes.fetchEntries({ ...ctx, known: async (urls) => new Set(urls) })
    ).toEqual([])
    expect(calls).toEqual([LIST])
  })

  test("a timed-out issue does not discard a readable sibling", async () => {
    const entries = await run(async (url) => {
      if (url === LIST)
        return answer(
          url,
          card("10/20/2026", "/archives/530") + card("10/20/2026")
        )
      if (url.endsWith("/530"))
        throw new SafeFetchError("unreachable", "timed out")
      return answer(url, savedPost)
    })
    expect(entries.map((entry) => entry.guid)).toEqual([POST])
  })
})
