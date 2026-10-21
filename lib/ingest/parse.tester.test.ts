import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { FeedParseError, normaliseEntry, parseFeed } from "./parse"

const BASE = "https://example.test/feeds/main.json"
const CAP = 200 * 1024
const jsonFeed = (items: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: "https://jsonfeed.org/version/1.1",
    ...extra,
    items,
  })
const hash = (text: string) => createHash("sha1").update(text).digest("hex")

describe("parser independent edge coverage", () => {
  test.each([
    jsonFeed([]),
    '<rss version="2.0"><channel><title>Empty</title></channel></rss>',
    '<feed xmlns="http://www.w3.org/2005/Atom"><title>Empty</title></feed>',
  ])("accepts a recognised empty feed %#", (body) => {
    expect(parseFeed(body, BASE).entries).toEqual([])
  })

  test.each([
    '{"version":"https://jsonfeed.org/version/1.1","items":[',
    '{"version":null,"items":[]}',
    '{"version":4,"items":[]}',
    '{"version":"https://jsonfeed.org/version/1.1","items":null}',
  ])("rejects malformed JSON Feed with a typed error %#", (body) => {
    try {
      parseFeed(body, BASE)
      throw new Error("expected rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(FeedParseError)
      expect((error as FeedParseError).code).toBe("invalid_feed")
    }
  })

  test("ignores non-object JSON items without losing subsequent valid entries", () => {
    const feed = parseFeed(
      jsonFeed([null, false, 1, "bad", { id: "ok", content_text: "kept" }]),
      BASE
    )
    expect(feed.entries).toHaveLength(1)
    expect(feed.entries[0]).toMatchObject({
      guid: "ok",
      summary: "kept",
      contentHtml: "<p>kept</p>",
    })
  })

  test("does not deduplicate, reorder or apply storage limits while parsing", () => {
    const items = Array.from({ length: 501 }, (_, i) => ({
      id: i === 500 ? "0" : String(i),
      title: `Entry ${i}`,
      date_published: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString(),
    }))
    const entries = parseFeed(jsonFeed(items), BASE).entries
    expect(entries).toHaveLength(501)
    expect(entries[0].guid).toBe("0")
    expect(entries[500]).toMatchObject({ guid: "0", title: "Entry 500" })
    expect(entries[1].publishedAt!.getTime()).toBeGreaterThan(
      entries[0].publishedAt!.getTime()
    )
  })

  test("preserves zero and opaque IDs, then falls back to resolved safe URL and dated hash", () => {
    const entries = parseFeed(
      jsonFeed([
        { id: 0, url: "/a" },
        { id: " urn:opaque:thing ", url: "/b" },
        { id: "  ", url: "../post?x=1" },
        {
          title: "Hash me",
          url: "javascript:evil()",
          date_published: "1970-01-01T00:00:00Z",
        },
      ]),
      BASE
    ).entries
    expect(entries.map((entry) => entry.guid)).toEqual([
      "0",
      "urn:opaque:thing",
      "https://example.test/post?x=1",
      hash("Hash me1970-01-01T00:00:00.000Z"),
    ])
    expect(entries[3].url).toBeNull()
  })

  test("normalises timezone and epoch, preserves future dates, and rejects invalid dates", () => {
    const entries = parseFeed(
      jsonFeed([
        { id: "offset", date_published: "2024-02-29T23:30:00-02:30" },
        { id: "epoch", date_published: "1970-01-01T00:00:00Z" },
        { id: "future", date_published: "2999-01-01T00:00:00Z" },
        {
          id: "bad",
          date_published: "definitely-not-a-date",
          date_modified: "still-invalid",
        },
        { id: "missing" },
      ]),
      BASE
    ).entries
    expect(
      entries.map((entry) => entry.publishedAt?.toISOString() ?? null)
    ).toEqual([
      "2024-03-01T02:00:00.000Z",
      "1970-01-01T00:00:00.000Z",
      "2999-01-01T00:00:00.000Z",
      null,
      null,
    ])
    expect(
      normaliseEntry({ published: new Date(NaN), updated: "bad" }, BASE)
        .publishedAt
    ).toBeNull()
  })

  test("caps Unicode summary/title fallback and integrates sanitisation with the entry URL base", () => {
    const [entry] = parseFeed(
      jsonFeed([
        {
          url: "../articles/post/index.html",
          content_html: `<p>${"😀".repeat(100_000)}</p><script>evil()</script>`,
          summary: "😀".repeat(301),
        },
      ]),
      BASE
    ).entries
    expect(Array.from(entry.summary!)).toHaveLength(300)
    expect(Array.from(entry.title)).toHaveLength(80)
    expect(
      new TextEncoder().encode(entry.contentHtml!).length
    ).toBeLessThanOrEqual(CAP)
    expect(entry.contentHtml).not.toContain("�")
    const [linked] = parseFeed(
      jsonFeed([
        {
          url: "../articles/post/index.html",
          content_html:
            '<picture><source src="image.webp" srcset="evil 2x"></picture><a href="../next">next</a><a href="&#106;avascript:evil()">bad</a>',
        },
      ]),
      BASE
    ).entries
    expect(linked.contentHtml).toBe(
      '<picture><source src="https://example.test/articles/post/image.webp" /></picture><a href="https://example.test/articles/next" rel="noopener noreferrer nofollow" target="_blank">next</a><a rel="noopener noreferrer nofollow" target="_blank">bad</a>'
    )
  })

  test("keeps entity-looking JSON text literal and prefers content_html", () => {
    const entries = parseFeed(
      jsonFeed(
        [
          {
            title: "<b>literal</b>",
            content_text: '<img src=x onerror="evil()"> &lt;script&gt;',
          },
          { content_html: "<p>HTML</p>", content_text: "text" },
        ],
        { home_page_url: "JaVa\nScRiPt:evil()", title: "<feed>" }
      ),
      BASE
    )
    expect(entries.title).toBe("<feed>")
    expect(entries.siteUrl).toBeNull()
    expect(entries.entries[0]).toMatchObject({
      title: "<b>literal</b>",
      summary: '<img src=x onerror="evil()"> &lt;script&gt;',
      contentHtml:
        '<p>&lt;img src=x onerror="evil()"&gt; &amp;lt;script&amp;gt;</p>',
    })
    expect(entries.entries[1].contentHtml).toBe("<p>HTML</p>")
  })

  test("Atom plain-text regression keeps literal markup escaped and IDs distinct", () => {
    const body = readFileSync(
      join(
        import.meta.dir,
        "../../test/fixtures/feeds/handmade-text-constructs.atom.xml"
      ),
      "utf8"
    )
    const feed = parseFeed(body, BASE)
    expect(feed.entries[0].contentHtml).toBe(
      "Use &lt;script&gt;alert(1)&lt;/script&gt; &amp; more"
    )
    expect(feed.entries[3].guid).not.toBe(feed.entries[4].guid)
    expect(feed.entries[0].contentHtml).not.toContain("<script")
  })
})
