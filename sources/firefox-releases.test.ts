import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type { SafeFetch } from "@/lib/ingest/safe-fetch"

import { firefoxReleases, releaseDate } from "./firefox-releases"

const FIXTURES = join(import.meta.dir, "../test/fixtures/firefox-releases")
const fixture = (file: string) => readFileSync(join(FIXTURES, file), "utf8")

const LIST = "https://www.firefox.com/en-US/releases/"
const notes = (v: string) =>
  `https://www.firefox.com/firefox/${v}/releasenotes/`

// Every listed post but `wanted` is known, so only those are read.
async function read(pages: Record<string, string>, wanted: string[]) {
  const fetch: SafeFetch = async (url) => ({
    status: pages[url] === undefined ? 404 : 200,
    url,
    headers: new Headers(),
    text: pages[url] ?? "",
    kind: "unknown",
  })
  const asked: string[][] = []
  const entries = await firefoxReleases.fetchEntries({
    url: LIST,
    fetch,
    known: async (urls) => {
      asked.push(urls)
      return new Set(urls.filter((url) => !wanted.includes(url)))
    },
    deadline: new AbortController().signal,
  })
  return { entries, listed: asked[0] }
}

const page = (body: string) =>
  `<!doctype html><html><head><title>Firefox</title></head><body>${body}</body></html>`

describe("firefox-releases", () => {
  const list = fixture("releases.html")

  test("accepts its spellings and nothing else", () => {
    expect(firefoxReleases.id).toBe("firefox-releases")
    for (const spelling of [
      LIST,
      "https://www.firefox.com/en-US/releases",
      "https://WWW.Firefox.com/en-US/releases/",
      "https://www.mozilla.org/en-US/firefox/releases/",
      "https://www.mozilla.org/en-US/firefox/releases",
      "https://mozilla.org/en-US/firefox/releases/",
      "https://mozilla.org/en-US/firefox/releases",
    ]) {
      const canonical = firefoxReleases.canonical(new URL(spelling))
      expect(canonical).toBe(LIST)
      expect(firefoxReleases.canonical(new URL(canonical!))).toBe(LIST)
    }
    for (const other of [
      "http://www.firefox.com/en-US/releases/",
      "https://firefox.com/en-US/releases/",
      "https://www.firefox.com/releases/",
      "https://www.firefox.com/de/releases/",
      "https://www.firefox.com/en-US/releases/?x=1",
      "https://www.firefox.com/en-US/releases/#top",
      "https://www.firefox.com:8443/en-US/releases/",
      "https://www.firefox.com/en-US/firefox/158.0/releasenotes/",
      "https://www.mozilla.org/en-US/firefox/",
      "https://www.mozilla.org/de/firefox/releases/",
      "https://www.firefox.com.evil.invalid/en-US/releases/",
    ]) {
      expect(firefoxReleases.canonical(new URL(other))).toBeNull()
    }
  })

  test("lists majors and dot releases in document order, without ESR, bounded to 30", async () => {
    const { listed } = await read({ [LIST]: list }, [])
    expect(listed).toHaveLength(30)
    expect(listed.slice(0, 14)).toEqual(
      [
        "158.0",
        "158.0.1",
        "157.0",
        "157.0.1",
        "156.0",
        "156.0.1",
        "155.0",
        "155.0.1",
        "154.0",
        "154.0.1",
        "153.0",
        "153.0.1",
        "153.0.3",
        "153.0.4",
      ].map(notes)
    )
    expect(listed.at(-1)).toBe(notes("150.0.3"))
    // The saved list links 153.0esr and 153.1.0 right after 153.0.4.
    expect(listed).not.toContain(notes("153.0esr"))
    expect(listed).not.toContain(notes("153.1.0"))
  })

  test("keeps same-origin release links only, without query or hash, once", async () => {
    const { listed } = await read(
      {
        [LIST]: page(
          `<a href="/firefox/158.0/releasenotes/?utm=x#top">158</a>` +
            `<a href="/firefox/158.0.1/releasenotes/">158.0.1</a>` +
            `<a href="/firefox/140.0esr/releasenotes/">ESR</a>` +
            `<a href="/firefox/140.3.0/releasenotes/">ESR dot</a>` +
            `<a href="/firefox/158.0b1/releasenotes/">Beta</a>` +
            `<a href="/firefox/158.0/system-requirements/">Reqs</a>` +
            `<a href="/firefox/158.0/releasenotes">No slash</a>` +
            `<a href="https://evil.invalid/firefox/157.0/releasenotes/">Off</a>` +
            `<a href="/firefox/158.0/releasenotes/">Again</a>` +
            `<a href="/firefox/157.0/releasenotes/">157</a>`
        ),
      },
      []
    )
    expect(listed).toEqual([notes("158.0"), notes("158.0.1"), notes("157.0")])
  })

  test("reads a major and a dot release: title, date and the whole notes", async () => {
    const { entries } = await read(
      {
        [LIST]: list,
        [notes("158.0")]: fixture("158.0.html"),
        [notes("158.0.1")]: fixture("158.0.1.html"),
      },
      [notes("158.0"), notes("158.0.1")]
    )
    const [major, dot] = entries
    expect(major).toMatchObject({
      guid: notes("158.0"),
      url: notes("158.0"),
      title: "Firefox 158.0",
      publishedAt: new Date("2026-10-13T00:00:00.000Z"),
    })
    expect(major.contentHtml).toContain(
      "<p>You can now fill in forms faster in <a"
    )
    expect(major.contentHtml).toContain(
      `<li>Kit Example: <a href="https://bugs.example/1973441"`
    )
    // The section headings stay in the body and out of the summary.
    expect(major.summary).toStartWith("You can now fill in forms faster")
    expect(major.contentHtml).toMatch(/<h3>\s*<span>[^]*New/)

    expect(dot).toMatchObject({
      guid: notes("158.0.1"),
      title: "Firefox 158.0.1",
      publishedAt: new Date("2026-10-20T00:00:00.000Z"),
    })
    expect(dot.summary).toStartWith(
      "Invented lanterns stopped flickering after a sample update"
    )
    expect(dot.contentHtml).toContain(
      "Invented lanterns stopped flickering after a sample update"
    )
    expect(dot.contentHtml).toContain("advisory-2026-111")

    for (const entry of [major, dot]) {
      // Sidebar, pagination, nav and footer are outside the notes.
      expect(entry.contentHtml).not.toContain("Get the most recent version")
      expect(entry.contentHtml).not.toContain("Get Involved")
      expect(entry.contentHtml).not.toContain("Cookie")
      expect(entry.contentHtml).not.toContain("<script")
    }
  })

  test("a page without the notes is an entry without content", async () => {
    const url = notes("158.0")
    const { entries } = await read(
      {
        [LIST]: list,
        [url]: page(
          `<p class="c-release-date">October 13, 2026</p><main><p>Moved.</p></main>`
        ),
      },
      [url]
    )
    expect(entries).toEqual([
      expect.objectContaining({
        guid: url,
        title: "Firefox 158.0",
        summary: null,
        contentHtml: null,
        publishedAt: new Date("2026-10-13T00:00:00.000Z"),
      }),
    ])
  })

  test("a page that is no release notes is not read", async () => {
    const url = notes("158.0")
    await expect(
      read({ [LIST]: list, [url]: page("<main><p>Not found</p></main>") }, [
        url,
      ])
    ).rejects.toThrow("none of the new posts could be read")
  })
})

describe("releaseDate", () => {
  test("reads the page's month day, year as UTC midnight", () => {
    expect(releaseDate("October 13, 2026")).toBe("2026-10-13T00:00:00.000Z")
    expect(releaseDate("\n  May 4, 2025 ")).toBe("2025-05-04T00:00:00.000Z")
    for (const bad of [
      "",
      "February 30, 2026",
      "Octember 1, 2026",
      "Oct 13, 2026",
      "october 13, 2026",
      "October 13 2026",
      "13 October 2026",
      "2026-10-13",
    ]) {
      expect(releaseDate(bad)).toBeNull()
    }
  })
})
