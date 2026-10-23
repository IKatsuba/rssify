import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { FeedParseError, normaliseEntry, parseFeed } from "./parse"

const FIXTURES = join(import.meta.dir, "../../test/fixtures/feeds")

// safe-fetch decodes in production; here each fixture is decoded with the
// charset it declares.
function fixture(name: string, charset = "utf-8"): string {
  return new TextDecoder(charset).decode(readFileSync(join(FIXTURES, name)))
}

function parseError(run: () => unknown): FeedParseError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(FeedParseError)
    return error as FeedParseError
  }
  throw new Error("expected a FeedParseError")
}

const sha1 = (value: string) => createHash("sha1").update(value).digest("hex")

describe("parseFeed: saved real feeds", () => {
  const cases = [
    {
      file: "claude-dev.rss.xml",
      url: "https://code.example/rss.xml",
      title: "Example Code Blog",
      siteUrl: "https://code.example/",
      count: 16,
      first: {
        guid: "https://code.example/blog/how-the-sample-team-reviews-code/",
        url: "https://code.example/blog/how-the-sample-team-reviews-code/",
        title: "How the sample team reviews code",
        author: "Ada Example, Bo Sample, and Cy Placeholder",
        publishedAt: "2026-10-15T12:00:00.000Z",
      },
    },
    {
      file: "cursor-changelog.rss.xml",
      url: "https://app.example/changelog/rss.xml",
      title: "Example Changelog",
      siteUrl: "https://app.example/changelog",
      count: 3,
      first: {
        guid: "https://app.example/changelog/shared-boards",
        url: "https://app.example/changelog/shared-boards",
        title: "Shared Boards and Faster Workspaces",
        author: null,
        publishedAt: "2026-10-16T00:00:00.000Z",
      },
    },
    {
      // No <guid>: identity falls back to the item's link.
      file: "hacker-news.rss.xml",
      url: "https://links.example/rss",
      title: "Link Board",
      siteUrl: "https://links.example/",
      count: 3,
      first: {
        guid: "https://one.example/blog/2026/10/21/todays-sample-release/",
        url: "https://one.example/blog/2026/10/21/todays-sample-release/",
        title: "Today's sample release, and how we're hardening it",
        author: null,
        publishedAt: "2026-10-21T15:48:56.000Z",
      },
    },
    {
      file: "slashdot.rdf.xml",
      charset: "iso-8859-1",
      url: "https://digest.example/rss",
      title: "Byte Digest",
      siteUrl: "https://digest.example/",
      count: 3,
      first: {
        guid: "https://linux.digest.example/story/2026/10/21/2200/invented-story?utm_source=rss1.0mainlinkanon&utm_medium=feed",
        url: "https://linux.digest.example/story/2026/10/21/2200/invented-story?utm_source=rss1.0mainlinkanon&utm_medium=feed",
        title: "Zürich café ships Ångström-scale sensors",
        author: "Ödön Exämple",
        publishedAt: "2026-10-21T22:00:00.000Z",
      },
    },
    {
      file: "opennet.rss.xml",
      charset: "koi8-r",
      url: "https://novosti.example/opennews/opennews_all.rss",
      title: "Новости примера: общая лента",
      siteUrl: "https://novosti.example/opennews/",
      count: 3,
      first: {
        guid: "https://novosti.example/opennews/art.shtml?num=101",
        url: "https://novosti.example/opennews/art.shtml?num=101",
        title: "Выпуск вымышленной среды Пример 2.0",
        author: null,
        publishedAt: "2026-10-21T19:39:07.000Z",
      },
    },
    {
      // Atom with only <updated>: that is the entry's date.
      file: "nextjs-releases.atom.xml",
      url: "https://code.example/sample/kit/releases.atom",
      title: "Release notes from sample-kit",
      siteUrl: "https://code.example/sample/kit/releases",
      count: 3,
      first: {
        guid: "tag:code.example,2008:Repository/1001/v3.1.0-canary.4",
        url: "https://code.example/sample/kit/releases/tag/v3.1.0-canary.4",
        title: "v3.1.0-canary.4",
        author: "release-bot[bot]",
        publishedAt: "2026-10-20T23:51:32.000Z",
      },
    },
    {
      file: "xkcd.atom.xml",
      url: "https://doodle.example/atom.xml",
      title: "Daily Doodle",
      siteUrl: "https://doodle.example/",
      count: 4,
      first: {
        guid: "https://doodle.example/104/",
        url: "https://doodle.example/104/",
        title: "Patch Day",
        author: null,
        publishedAt: "2026-10-21T00:00:00.000Z",
      },
    },
    {
      file: "jsonfeed-org.feed.json",
      url: "https://jsonfeed.example/feed.json",
      title: "Sample JSON Feed",
      siteUrl: "https://jsonfeed.example/",
      count: 2,
      first: {
        guid: "http://mirror.example/2020/08/07/sample-version.html",
        url: "https://jsonfeed.example/2020/08/07/sample-version.html",
        title: "Sample format version 1.1",
        author: null,
        publishedAt: "2020-08-07T16:44:36.000Z",
      },
    },
    {
      file: "daringfireball.feed.json",
      url: "https://fireside.example/feeds/json",
      title: "Fireside Notes",
      siteUrl: "https://fireside.example/",
      count: 3,
      first: {
        guid: "https://fireside.example/feeds/sponsors/2026/10/widgetly_1",
        url: "https://fireside.example/feeds/sponsors/2026/10/widgetly_1",
        title: "[Sponsor] Widgetly",
        author: "Fireside Sponsorship Desk",
        publishedAt: "2026-10-20T13:09:38.000Z",
      },
    },
  ]

  for (const c of cases) {
    test(c.file, () => {
      const feed = parseFeed(fixture(c.file, c.charset), c.url)
      expect(feed.title).toBe(c.title)
      expect(feed.siteUrl).toBe(c.siteUrl)
      expect(feed.entries).toHaveLength(c.count)
      const first = feed.entries[0]
      expect({
        guid: first.guid,
        url: first.url,
        title: first.title,
        author: first.author,
        publishedAt: first.publishedAt?.toISOString() ?? null,
      }).toEqual(c.first)
      for (const entry of feed.entries) {
        expect(entry.guid).not.toBe("")
        expect(entry.title).not.toBe("")
        expect(entry.summary?.length ?? 0).toBeLessThanOrEqual(300)
        expect(entry.contentHtml ?? "").not.toMatch(/<script|\son\w+=/i)
      }
    })
  }

  test("keeps document order and HTML content", () => {
    const feed = parseFeed(
      fixture("cursor-changelog.rss.xml"),
      "https://app.example/changelog/rss.xml"
    )
    expect(feed.entries[0].contentHtml).toStartWith(
      '<h2>Boards from workers</h2>\n<p><a href="https://app.example/docs/workers" rel="noopener noreferrer nofollow" target="_blank">Workers</a>'
    )
    expect(feed.entries[0].summary).toStartWith(
      "Workers can now build and share boards."
    )
  })
})

describe("parseFeed: failures", () => {
  test("an HTML page is not a feed", () => {
    expect(
      parseError(() =>
        parseFeed(fixture("cursor-blog.html"), "https://cursor.com/blog")
      ).code
    ).toBe("not_a_feed")
  })

  test("XML without a feed root and plain text are not feeds", () => {
    const url = "https://ex.com/x"
    expect(
      parseError(() => parseFeed("<?xml version='1.0'?><foo/>", url)).code
    ).toBe("not_a_feed")
    expect(parseError(() => parseFeed("hello", url)).code).toBe("not_a_feed")
  })

  test("an empty body is an invalid feed", () => {
    expect(parseError(() => parseFeed("", "https://ex.com/x")).code).toBe(
      "invalid_feed"
    )
    expect(parseError(() => parseFeed("﻿  \n", "https://ex.com/x")).code).toBe(
      "invalid_feed"
    )
  })

  test("JSON that is not a JSON Feed is an invalid feed", () => {
    const url = "https://ex.com/feed.json"
    for (const body of [
      "{not json",
      '{"items": []}',
      '{"version": "https://example.com/version/1", "items": []}',
      '{"version": "https://jsonfeed.org/version/1.1", "items": {}}',
    ])
      expect(parseError(() => parseFeed(body, url)).code).toBe("invalid_feed")
  })

  test("a truncated RSS file gives the items before the cut", () => {
    const feed = parseFeed(
      fixture("handmade-truncated.rss.xml"),
      "https://code.example/rss.xml"
    )
    expect(feed.entries).toHaveLength(8)
    expect(feed.entries[0].guid).toBe(
      "https://code.example/blog/how-the-sample-team-reviews-code/"
    )
  })

  test("a truncated Atom file is an invalid feed", () => {
    expect(
      parseError(() =>
        parseFeed(
          fixture("handmade-truncated.atom.xml"),
          "https://code.example/sample/kit/releases.atom"
        )
      ).code
    ).toBe("invalid_feed")
  })

  test("a leading BOM and whitespace are ignored", () => {
    const body = "﻿\n  " + fixture("xkcd.atom.xml")
    expect(
      parseFeed(body, "https://doodle.example/atom.xml").entries
    ).toHaveLength(4)
  })
})

describe("parseFeed: hand-made edge cases", () => {
  test("xml:base and hostile HTML are resolved and sanitised", () => {
    const feed = parseFeed(
      fixture("handmade-hostile.atom.xml"),
      "https://example.com/feed.atom"
    )
    expect(feed.title).toBe("Hostile & based")
    expect(feed.siteUrl).toBe("https://example.com/blog/")
    expect(feed.entries).toEqual([
      {
        guid: "urn:example:post-1",
        url: "https://example.com/blog/post-1",
        title: "Post one",
        author: "Eve",
        publishedAt: new Date("2026-10-01T10:00:00Z"),
        summary: "Short summary",
        contentHtml:
          '<p>Hello</p><img src="https://example.com/blog/x" />' +
          '<a rel="noopener noreferrer nofollow" target="_blank">bad</a>' +
          '<a href="https://example.com/about" rel="noopener noreferrer nofollow" target="_blank">about</a>' +
          '<img src="https://example.com/blog/pic.png" />',
      },
    ])
  })

  test("Atom text constructs keep literal tags as text", () => {
    const feed = parseFeed(
      fixture("handmade-text-constructs.atom.xml"),
      "https://example.com/feed.atom"
    )
    expect(feed.title).toBe("Notes on <tag>")
    const [plain, explicit, html, noIdA, noIdB] = feed.entries
    expect(plain).toMatchObject({
      title: "Use <tag>",
      summary: "Use <script>alert(1)</script> & more",
      contentHtml: "Use &lt;script&gt;alert(1)&lt;/script&gt; &amp; more",
    })
    expect(explicit).toMatchObject({
      title: "Explicit <b>text</b>",
      summary: "A <summary>",
      contentHtml: "A &lt;summary&gt;",
    })
    expect(html).toMatchObject({
      title: "Bold html",
      summary: "Real markup",
      contentHtml: "<p>Real <em>markup</em></p>",
    })
    expect(noIdA.guid).toBe(sha1("No id <a>"))
    expect(noIdB.guid).toBe(sha1("No id <b>"))
  })

  test("links, guids, dates and titles fall back as specified", () => {
    const feed = parseFeed(
      fixture("handmade-edge-cases.rss.xml"),
      "https://feed.example/rss.xml"
    )
    // The channel's javascript: link is not kept as the site URL.
    expect(feed.siteUrl).toBeNull()
    const [noLink, jsLink, blankGuid, longSummary, empty] = feed.entries

    expect(noLink.url).toBeNull()
    expect(noLink.publishedAt).toEqual(new Date("2026-10-21T10:00:00Z"))
    expect(noLink.guid).toBe(sha1("No link, no guid2026-10-21T10:00:00.000Z"))

    expect(jsLink.url).toBeNull()
    expect(jsLink.publishedAt).toBeNull()
    expect(jsLink.guid).toBe(sha1("JavaScript link"))

    expect(blankGuid.url).toBe("https://feed.example/posts/3")
    expect(blankGuid.guid).toBe("https://feed.example/posts/3")
    expect(blankGuid.publishedAt).toBeNull()

    expect(longSummary.title).toBe(
      "A title-less item whose summary is long enough to be cut at eighty characters fo"
    )
    expect(Array.from(longSummary.title)).toHaveLength(80)

    expect(empty).toEqual({
      guid: sha1("(untitled)"),
      url: null,
      title: "(untitled)",
      author: null,
      publishedAt: null,
      summary: null,
      contentHtml: null,
    })
  })

  test("JSON Feed content_text is escaped, not parsed", () => {
    const feed = parseFeed(
      fixture("handmade-content-text.feed.json"),
      "https://example.com/feed.json"
    )
    expect(feed.title).toBe("Plain <text> feed")
    expect(feed.siteUrl).toBe("https://example.com/")
    expect(feed.entries).toHaveLength(3)
    const [text, html, bare] = feed.entries
    expect(text).toEqual({
      guid: "1",
      url: "https://example.com/1",
      title: "Use <tag> & more",
      author: "Old Author",
      publishedAt: new Date("2026-10-03T00:00:00Z"),
      summary: "About <tag>",
      contentHtml:
        "<p>Use the &lt;tag&gt; element &amp; &lt;script&gt;alert(1)&lt;/script&gt;</p>",
    })
    expect(html).toMatchObject({
      guid: "2",
      url: null,
      author: "New Author",
      publishedAt: null,
      contentHtml: "<p>Hi</p>",
    })
    expect(bare.guid).toBe(sha1("No id, no url"))
    expect(bare.contentHtml).toBe("<p>No id, no url</p>")
  })
})

describe("normaliseEntry", () => {
  test("never dates an undated entry with now", () => {
    const entry = normaliseEntry(
      { title: "t", published: "garbage", updated: null },
      "https://ex.com/"
    )
    expect(entry.publishedAt).toBeNull()
  })

  test("falls back to updated and resolves against the base", () => {
    const entry = normaliseEntry(
      {
        id: "  ",
        url: "a/b",
        title: " <i>Hi</i> ",
        updated: new Date("2026-01-02T03:04:05Z"),
        content: '<a href="c">c</a>',
      },
      "https://ex.com/x/"
    )
    expect(entry).toEqual({
      guid: "https://ex.com/x/a/b",
      url: "https://ex.com/x/a/b",
      title: "Hi",
      author: null,
      publishedAt: new Date("2026-01-02T03:04:05Z"),
      summary: "c",
      contentHtml:
        '<a href="https://ex.com/x/a/c" rel="noopener noreferrer nofollow" target="_blank">c</a>',
    })
  })
})
