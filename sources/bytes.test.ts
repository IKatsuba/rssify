import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"
import { load } from "cheerio"

import type { SafeFetch } from "@/lib/ingest/safe-fetch"

import { bytes, cardDate } from "./bytes"

const FIXTURES = join(import.meta.dir, "../test/fixtures/bytes")
const fixture = (file: string) => readFileSync(join(FIXTURES, file), "utf8")

const LIST = "https://bytes.dev/archives"
const issue = (n: number) => `${LIST}/${n}`

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
  const entries = await bytes.fetchEntries({
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

const page = (head: string, body = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

describe("bytes", () => {
  const list = fixture("archives.html")

  test("accepts its spellings and nothing else", () => {
    expect(bytes.id).toBe("bytes")
    for (const spelling of [
      LIST,
      `${LIST}/`,
      "https://www.bytes.dev/archives",
      "https://www.bytes.dev/archives/",
      "https://Bytes.dev/archives",
    ]) {
      const canonical = bytes.canonical(new URL(spelling))
      expect(canonical).toBe(LIST)
      expect(bytes.canonical(new URL(canonical!))).toBe(LIST)
    }
    for (const other of [
      "http://bytes.dev/archives",
      `${LIST}?page=2`,
      `${LIST}#top`,
      `${LIST}/531`,
      "https://bytes.dev/",
      "https://bytes.dev:8443/archives",
      "https://ui.dev/archives",
      "https://bytes.dev.evil.invalid/archives",
    ]) {
      expect(bytes.canonical(new URL(other))).toBeNull()
    }
  })

  test("lists the issues newest first, bounded to the first 30", async () => {
    const { listed } = await read({ [LIST]: list }, [])
    expect(listed).toHaveLength(30)
    expect(listed.slice(0, 3)).toEqual([issue(531), issue(530), issue(529)])
    expect(listed.at(-1)).toBe(issue(502))
  })

  test("keeps numeric same-origin issue links only, without query or hash, once", async () => {
    const { listed } = await read(
      {
        [LIST]: page(
          "",
          `<a href="/archives/3?ref=x#top"><span>1/2/2026</span></a>` +
            `<a href="/archives/latest">Latest</a>` +
            `<a href="/archives/3/extra">Extra</a>` +
            `<a href="//evil.invalid/archives/9">Off</a>` +
            `<a href="/archives/3">Again</a>` +
            `<a href="/archives/2">Two</a>`
        ),
      },
      []
    )
    expect(listed).toEqual([issue(3), issue(2)])
  })

  test("reads two issue templates: title, card date and the whole body", async () => {
    const { entries } = await read(
      {
        [LIST]: list,
        [issue(531)]: fixture("531.html"),
        [issue(400)]: fixture("400.html"),
      },
      [issue(531)]
    )
    const [latest] = entries
    expect(latest).toMatchObject({
      guid: issue(531),
      url: issue(531),
      title: "Bytes #531 - A Journey Through the Sock Drawer",
      publishedAt: new Date("2026-10-20T00:00:00.000Z"),
    })
    expect(latest.summary).toStartWith(
      "Folding socks, a review of invented drawers"
    )
    expect(latest.contentHtml).toContain("Today’s issue:")
    expect(latest.contentHtml).toContain("doesn’t mutate the original pile")

    // #400 is past the 30 candidates, so its own card from the saved
    // archive is the whole list; the site does not pad its date.
    const $ = load(list)
    const old = await read(
      {
        [LIST]: page("", $.html($('a[href="/archives/400"]'))),
        [issue(400)]: fixture("400.html"),
      },
      [issue(400)]
    )
    const [anniversary] = old.entries
    expect(anniversary).toMatchObject({
      guid: issue(400),
      title: "Bytes #400 - Teapots, poured slowly",
      publishedAt: new Date("2025-06-12T00:00:00.000Z"),
    })
    expect(anniversary.contentHtml).toContain(
      "Four hundred issues about teapots"
    )
    expect(anniversary.contentHtml).toContain(
      "<code>Gamma</code>, <code>Beta</code>."
    )

    for (const entry of [latest, anniversary]) {
      // Nav and footer are outside the body.
      expect(entry.contentHtml).not.toContain("Learn Sample Knitting")
      expect(entry.contentHtml).not.toContain("Made with")
      expect(entry.contentHtml).not.toContain("<script")
    }
  })

  test("a page without the body is a summary-only entry", async () => {
    const url = issue(531)
    const { entries } = await read(
      {
        [LIST]: list,
        [url]: page(
          '<meta property="og:title" content="Bytes #531 &amp; more">' +
            '<meta name="description" content="Short <b>text</b>">',
          "<main><p>Welcome to #531.</p></main>"
        ),
      },
      [url]
    )
    // normaliseEntry gives an entry without content its summary, as it
    // does a feed item without one.
    expect(entries).toEqual([
      expect.objectContaining({
        guid: url,
        title: "Bytes #531 & more",
        summary: "Short <b>text</b>",
        contentHtml: "Short &lt;b&gt;text&lt;/b&gt;",
        publishedAt: new Date("2026-10-20T00:00:00.000Z"),
      }),
    ])
  })
})

describe("cardDate", () => {
  test("reads the card's month/day/year, padded or not, as UTC midnight", () => {
    expect(cardDate("10/20/2026")).toBe("2026-10-20T00:00:00.000Z")
    expect(cardDate("10/9/2026")).toBe("2026-10-09T00:00:00.000Z")
    expect(cardDate(" 6/12/2025 ")).toBe("2025-06-12T00:00:00.000Z")
    for (const bad of [
      "",
      "Invalid Date",
      "2/30/2026",
      "13/1/2026",
      "0/1/2026",
      "10/20/26",
      "2026-10-20",
      "20/10/2026",
      "Oct 20, 2026",
    ]) {
      expect(cardDate(bad)).toBeNull()
    }
  })
})
