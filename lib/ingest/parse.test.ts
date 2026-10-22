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
      url: "https://claude.dev/rss.xml",
      title: "claude.dev Blog",
      siteUrl: "https://claude.dev/",
      count: 16,
      first: {
        guid: "https://claude.dev/blog/solving-code-review-at-anthropic/",
        url: "https://claude.dev/blog/solving-code-review-at-anthropic/",
        title: "How the Claude Code team does code review",
        author: "Addy Osmani, Morgan Westlee Lunt, and Qing Wang",
        publishedAt: "2026-10-15T12:00:00.000Z",
      },
    },
    {
      file: "cursor-changelog.rss.xml",
      url: "https://cursor.com/changelog/rss.xml",
      title: "Cursor Changelog",
      siteUrl: "https://cursor.com/changelog",
      count: 50,
      first: {
        guid: "https://cursor.com/changelog/cloud-agent-canvases-and-environments",
        url: "https://cursor.com/changelog/cloud-agent-canvases-and-environments",
        title: "Cloud Agent Canvases and Environment Improvements",
        author: null,
        publishedAt: "2026-10-16T00:00:00.000Z",
      },
    },
    {
      // No <guid>: identity falls back to the item's link.
      file: "hacker-news.rss.xml",
      url: "https://news.ycombinator.com/rss",
      title: "Hacker News",
      siteUrl: "https://news.ycombinator.com/",
      count: 30,
      first: {
        guid: "https://thephp.foundation/blog/2026/10/21/todays-php-security-release-and-how-were-strengthening-php-security/",
        url: "https://thephp.foundation/blog/2026/10/21/todays-php-security-release-and-how-were-strengthening-php-security/",
        title:
          "Today's PHP security release, and how we're strengthening security",
        author: null,
        publishedAt: "2026-10-21T15:48:56.000Z",
      },
    },
    {
      file: "slashdot.rdf.xml",
      charset: "iso-8859-1",
      url: "https://rss.slashdot.org/Slashdot/slashdotMain",
      title: "Slashdot",
      siteUrl: "https://slashdot.org/",
      count: 15,
      first: {
        guid: "https://linux.slashdot.org/story/26/10/21/2030239/amd-brings-ryzen-overclocking-driver-to-linux?utm_source=rss1.0mainlinkanon&utm_medium=feed",
        url: "https://linux.slashdot.org/story/26/10/21/2030239/amd-brings-ryzen-overclocking-driver-to-linux?utm_source=rss1.0mainlinkanon&utm_medium=feed",
        title: "AMD Brings Ryzen Overclocking Driver to Linux",
        author: "BeauHD",
        publishedAt: "2026-10-21T22:00:00.000Z",
      },
    },
    {
      file: "opennet.rss.xml",
      charset: "koi8-r",
      url: "https://www.opennet.ru/opennews/opennews_all.rss",
      title: "OpenNews.opennet.ru: Общая лента новостей",
      siteUrl: "https://www.opennet.ru/opennews/",
      count: 40,
      first: {
        guid: "https://www.opennet.ru/opennews/art.shtml?num=66522",
        url: "https://www.opennet.ru/opennews/art.shtml?num=66522",
        title: "Выпуск пользовательского окружения Dux Shell 2.0",
        author: null,
        publishedAt: "2026-10-21T19:39:07.000Z",
      },
    },
    {
      // Atom with only <updated>: that is the entry's date.
      file: "nextjs-releases.atom.xml",
      url: "https://github.com/vercel/next.js/releases.atom",
      title: "Release notes from next.js",
      siteUrl: "https://github.com/vercel/next.js/releases",
      count: 10,
      first: {
        guid: "tag:github.com,2008:Repository/70107786/v16.5.0-canary.21",
        url: "https://github.com/vercel/next.js/releases/tag/v16.5.0-canary.21",
        title: "v16.5.0-canary.21",
        author: "next-js-bot[bot]",
        publishedAt: "2026-10-20T23:51:32.000Z",
      },
    },
    {
      file: "xkcd.atom.xml",
      url: "https://xkcd.com/atom.xml",
      title: "xkcd.com",
      siteUrl: "https://xkcd.com/",
      count: 4,
      first: {
        guid: "https://xkcd.com/3314/",
        url: "https://xkcd.com/3314/",
        title: "Vulnerability",
        author: null,
        publishedAt: "2026-10-21T00:00:00.000Z",
      },
    },
    {
      file: "jsonfeed-org.feed.json",
      url: "https://www.jsonfeed.org/feed.json",
      title: "JSON Feed",
      siteUrl: "https://www.jsonfeed.org/",
      count: 2,
      first: {
        guid: "http://jsonfeed.micro.blog/2020/08/07/json-feed-version.html",
        url: "https://www.jsonfeed.org/2020/08/07/json-feed-version.html",
        title: "JSON Feed version 1.1",
        author: null,
        publishedAt: "2020-08-07T16:44:36.000Z",
      },
    },
    {
      file: "daringfireball.feed.json",
      url: "https://daringfireball.net/feeds/json",
      title: "Daring Fireball",
      siteUrl: "https://daringfireball.net/",
      count: 48,
      first: {
        guid: "https://daringfireball.net/feeds/sponsors/2026/10/sunnny_1",
        url: "https://daringfireball.net/feeds/sponsors/2026/10/sunnny_1",
        title: "[Sponsor] Sunnny",
        author: "Daring Fireball Department of Commerce",
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
      "https://cursor.com/changelog/rss.xml"
    )
    expect(feed.entries[0].contentHtml).toStartWith(
      '<h2>Canvases from cloud agents</h2>\n<p><a href="https://cursor.com/docs/cloud-agent" rel="noopener noreferrer nofollow" target="_blank">Cloud agents</a>'
    )
    expect(feed.entries[0].summary).toStartWith(
      "Cloud agents can now build and share interactive canvases."
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
      "https://claude.dev/rss.xml"
    )
    expect(feed.entries).toHaveLength(8)
    expect(feed.entries[0].guid).toBe(
      "https://claude.dev/blog/solving-code-review-at-anthropic/"
    )
  })

  test("a truncated Atom file is an invalid feed", () => {
    expect(
      parseError(() =>
        parseFeed(
          fixture("handmade-truncated.atom.xml"),
          "https://github.com/vercel/next.js/releases.atom"
        )
      ).code
    ).toBe("invalid_feed")
  })

  test("a leading BOM and whitespace are ignored", () => {
    const body = "﻿\n  " + fixture("xkcd.atom.xml")
    expect(parseFeed(body, "https://xkcd.com/atom.xml").entries).toHaveLength(4)
  })
})

describe("parseFeed: hand-made edge cases", () => {
  test("xml:base and hostile HTML are resolved and sanitised", () => {
    const feed = parseFeed(
      fixture("handmade-hostile.atom.xml"),
      "https://ex.com/feed.atom"
    )
    expect(feed.title).toBe("Hostile & based")
    expect(feed.siteUrl).toBe("https://ex.com/blog/")
    expect(feed.entries).toEqual([
      {
        guid: "urn:example:post-1",
        url: "https://ex.com/blog/post-1",
        title: "Post one",
        author: "Eve",
        publishedAt: new Date("2026-10-01T10:00:00Z"),
        summary: "Short summary",
        contentHtml:
          '<p>Hello</p><img src="https://ex.com/blog/x" />' +
          '<a rel="noopener noreferrer nofollow" target="_blank">bad</a>' +
          '<a href="https://ex.com/about" rel="noopener noreferrer nofollow" target="_blank">about</a>' +
          '<img src="https://ex.com/blog/pic.png" />',
      },
    ])
  })

  test("Atom text constructs keep literal tags as text", () => {
    const feed = parseFeed(
      fixture("handmade-text-constructs.atom.xml"),
      "https://ex.com/feed.atom"
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
      "https://ex.com/feed.json"
    )
    expect(feed.title).toBe("Plain <text> feed")
    expect(feed.siteUrl).toBe("https://ex.com/")
    expect(feed.entries).toHaveLength(3)
    const [text, html, bare] = feed.entries
    expect(text).toEqual({
      guid: "1",
      url: "https://ex.com/1",
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
