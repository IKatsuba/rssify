import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type { SafeFetch } from "@/lib/ingest/safe-fetch"

import { anthropicEngineering, anthropicNews, listDate } from "./anthropic"
import type { SourcePlugin } from "./types"

const FIXTURES = join(import.meta.dir, "../test/fixtures")
const fixture = (path: string) => readFileSync(join(FIXTURES, path), "utf8")

const ORIGIN = "https://www.anthropic.com"
const research = (slug: string) => `${ORIGIN}/research/${slug}`

function site(pages: Record<string, string>) {
  const calls: string[] = []
  const fetch: SafeFetch = async (url) => {
    calls.push(url)
    const text = pages[url]
    return {
      status: text === undefined ? 404 : 200,
      url,
      headers: new Headers(),
      text: text ?? "",
      kind: "unknown",
    }
  }
  return { fetch, calls }
}

// Every listed post but `wanted` is known, so only those are read.
async function read(
  plugin: SourcePlugin,
  pages: Record<string, string>,
  wanted: string[]
) {
  const s = site(pages)
  const asked: string[][] = []
  const entries = await plugin.fetchEntries({
    url: `${ORIGIN}/${plugin.id.replace("anthropic-", "")}`,
    fetch: s.fetch,
    known: async (urls) => {
      asked.push(urls)
      return new Set(urls.filter((url) => !wanted.includes(url)))
    },
    deadline: new AbortController().signal,
  })
  return { entries, listed: asked[0], calls: s.calls }
}

const page = (head: string, body = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

describe("anthropicEngineering", () => {
  const list = fixture("anthropic-engineering/list.html")
  const LIST = `${ORIGIN}/engineering`

  test("accepts its spellings and nothing else", () => {
    expect(anthropicEngineering.id).toBe("anthropic-engineering")
    for (const spelling of [
      LIST,
      `${LIST}/`,
      "https://anthropic.com/engineering",
      "https://anthropic.com/engineering/",
      "https://WWW.Anthropic.com/engineering",
    ]) {
      const canonical = anthropicEngineering.canonical(new URL(spelling))
      expect(canonical).toBe(LIST)
      expect(anthropicEngineering.canonical(new URL(canonical!))).toBe(LIST)
    }
    for (const other of [
      "http://www.anthropic.com/engineering",
      `${LIST}?page=2`,
      `${LIST}#top`,
      `${LIST}/managed-agents`,
      "https://www.anthropic.com:8443/engineering",
      "https://docs.anthropic.com/engineering",
      "https://www.anthropic.com.evil.invalid/engineering",
      `${ORIGIN}/news`,
      `${ORIGIN}/research`,
    ]) {
      expect(anthropicEngineering.canonical(new URL(other))).toBeNull()
    }
  })

  test("lists every card's post, under /research, in document order", async () => {
    const { listed } = await read(anthropicEngineering, { [LIST]: list }, [])
    expect(listed).toHaveLength(24)
    expect(listed.slice(0, 4)).toEqual([
      research("redesigning-source-control"),
      research("painting-the-boathouse"),
      research("april-storm-notes"),
      research("managed-agents"),
    ])
    expect(listed.at(-1)).toBe(research("thinking-about-lamps"))
    expect(new Set(listed).size).toBe(listed.length)
  })

  test("reads the saved posts: title, date and the whole body", async () => {
    const wanted = [
      research("redesigning-source-control"),
      research("managed-agents"),
    ]
    const { entries } = await read(
      anthropicEngineering,
      {
        [LIST]: list,
        [wanted[0]]: fixture(
          "anthropic-engineering/redesigning-source-control.html"
        ),
        [wanted[1]]: fixture("anthropic-engineering/managed-agents.html"),
      },
      wanted
    )
    const [git, agents] = entries
    expect(git).toMatchObject({
      guid: wanted[0],
      url: wanted[0],
      title: "Redesigning a lighthouse control room",
      publishedAt: new Date("2026-10-13T00:00:00.000Z"),
      author: null,
    })
    expect(git.summary).toStartWith("As the lamp grew brighter each winter")
    expect(git.contentHtml).toContain(
      "At the sample lighthouse, the lamp is no longer the hard part"
    )
    expect(git.contentHtml).toContain("spent nearly two decades oiling")

    expect(agents).toMatchObject({
      guid: wanted[1],
      title: "Keeping bees on a rooftop",
      publishedAt: new Date("2026-04-08T00:00:00.000Z"),
    })
    expect(agents.contentHtml).toContain("Start your own rooftop hive")
    expect(agents.contentHtml).toContain("However many hives sit on the roof")

    for (const entry of entries) {
      // Nav and footer are outside the body.
      expect(entry.contentHtml).not.toContain("Try the sample app")
      expect(entry.contentHtml).not.toContain("Invented terms and notices")
      expect(entry.contentHtml).not.toContain("<script")
    }
  })

  test("a post with the site-wide description is summarised by its first paragraph", async () => {
    const generic = research("harness-design-long-running-apps")
    const normal = research("managed-agents")
    const { entries } = await read(
      anthropicEngineering,
      {
        [LIST]: list,
        [generic]: fixture(
          "anthropic-engineering/harness-design-long-running-apps.html"
        ),
        [normal]: fixture("anthropic-engineering/managed-agents.html"),
      },
      [generic, normal]
    )
    const byUrl = Object.fromEntries(entries.map((e) => [e.url, e]))

    expect(byUrl[generic].title).toBe("Designing a harness for sled dogs")
    expect(byUrl[generic].summary).toStartWith(
      "Over the past few winters we have been sewing harnesses"
    )
    // Cut like every other summary.
    expect(byUrl[generic].summary!.length).toBeLessThanOrEqual(300)
    expect(byUrl[generic].summary).not.toContain(
      "lighthouses, bees and sled dogs"
    )

    expect(byUrl[normal].summary).toBe(
      "Rooftop hives need shade, water and a calm keeper. See how our invented hives stay steady through the seasons."
    )
  })

  test("without a list page description, a post's description is its summary", async () => {
    const url = research("harness-design-long-running-apps")
    const { entries } = await read(
      anthropicEngineering,
      {
        [LIST]: page(
          "",
          `<article><h3><a href="/research/harness-design-long-running-apps">Harness</a></h3></article>`
        ),
        [url]: fixture(
          "anthropic-engineering/harness-design-long-running-apps.html"
        ),
      },
      [url]
    )
    expect(entries[0].summary).toBe(
      "An invented company that writes sample notes about lighthouses, bees and sled dogs."
    )
  })

  test("a page without the body is a summary-only entry, its title without the site suffix", async () => {
    const url = research("managed-agents")
    const { entries } = await read(
      anthropicEngineering,
      {
        [LIST]: list,
        [url]: page(
          '<meta property="og:title" content="Agents &amp; harnesses | Anthropic">' +
            '<meta name="description" content="Short <b>text</b>">' +
            '<meta property="article:published_time" content="2026-04-08T00:00:00.000Z">',
          "<main><p>Not a post-text paragraph</p></main>"
        ),
      },
      [url]
    )
    // normaliseEntry gives an entry without content its summary, as it
    // does a feed item without one.
    expect(entries).toEqual([
      expect.objectContaining({
        guid: url,
        title: "Agents & harnesses",
        summary: "Short <b>text</b>",
        contentHtml: "Short &lt;b&gt;text&lt;/b&gt;",
        publishedAt: new Date("2026-04-08T00:00:00.000Z"),
      }),
    ])
  })

  test("without a published time the list date is used, else none", async () => {
    const dated = research("managed-agents")
    const { entries } = await read(
      anthropicEngineering,
      {
        [LIST]: list,
        [dated]: page(
          '<meta property="og:title" content="Managed agents">',
          '<div><p class="post-text">Body.</p></div>'
        ),
      },
      [dated]
    )
    expect(entries[0].publishedAt).toEqual(new Date("2026-04-08T00:00:00.000Z"))
    expect(entries[0].contentHtml).toContain("Body.")

    const undated = research("undated")
    const bare = await read(
      anthropicEngineering,
      {
        [LIST]: page(
          "",
          `<article><time>Someday</time><h3><a href="/research/undated?ref=x#a">Undated</a></h3></article>` +
            `<article><h3><a href="https://example.com/off-site">Off</a></h3></article>` +
            `<article><h3><a href="/research/undated">Again</a></h3></article>`
        ),
        [undated]: page('<meta property="og:title" content="Undated">'),
      },
      [undated]
    )
    expect(bare.listed).toEqual([undated])
    expect(bare.entries[0].publishedAt).toBeNull()
  })
})

describe("listDate", () => {
  test("reads the list's day text as UTC midnight", () => {
    expect(listDate("Apr 8, 2026")).toBe("2026-04-08T00:00:00.000Z")
    expect(listDate(" Oct 13, 2026 ")).toBe("2026-10-13T00:00:00.000Z")
    for (const bad of [
      "",
      "Someday",
      "April 8, 2026",
      "Feb 30, 2026",
      "8 Apr 2026",
    ]) {
      expect(listDate(bad)).toBeNull()
    }
  })
})

describe("anthropicNews", () => {
  const list = fixture("anthropic-news/list.html")
  const LIST = `${ORIGIN}/news`
  const news = (slug: string) => `${ORIGIN}/news/${slug}`

  test("accepts its spellings and nothing else", () => {
    expect(anthropicNews.id).toBe("anthropic-news")
    for (const spelling of [
      LIST,
      `${LIST}/`,
      "https://anthropic.com/news",
      "https://anthropic.com/news/",
    ]) {
      const canonical = anthropicNews.canonical(new URL(spelling))
      expect(canonical).toBe(LIST)
      expect(anthropicNews.canonical(new URL(canonical!))).toBe(LIST)
    }
    for (const other of [
      "http://anthropic.com/news",
      `${LIST}?subjects=policy`,
      `${LIST}/announcements`,
      `${ORIGIN}/engineering`,
      "https://claude.com/news",
    ]) {
      expect(anthropicNews.canonical(new URL(other))).toBeNull()
    }
  })

  // The most fragile selector of the sources: CSS-module component names.
  test("lists tile and row links through their CSS-module component names, topic links excluded", async () => {
    const { listed } = await read(anthropicNews, { [LIST]: list }, [])
    expect(listed).toHaveLength(24)
    expect(listed.slice(0, 6)).toEqual([
      `${ORIGIN}/claude-opus-5-5`,
      news("community-garden-fund"),
      news("cyber-verification-program"),
      `${ORIGIN}/sample-kite-2`,
      `${ORIGIN}/sample-boat-3`,
      news("new-gardener-joins"),
    ])
    expect(listed).toContain(`${ORIGIN}/features/ebola-response`)
    expect(listed).toContain(`${ORIGIN}/sample-lamp-and-lantern-1`)
    expect(listed.at(-1)).toBe(news("orchard-research-grants"))
    expect(new Set(listed).size).toBe(listed.length)
    for (const topic of ["announcements", "policy", "product"]) {
      expect(listed).not.toContain(news(topic))
    }
  })

  test("reads a post, a launch page and a feature page", async () => {
    const post = news("cyber-verification-program")
    const launch = `${ORIGIN}/claude-opus-5-5`
    const feature = `${ORIGIN}/features/ebola-response`
    const { entries } = await read(
      anthropicNews,
      {
        [LIST]: list,
        [post]: fixture("anthropic-news/cyber-verification-program.html"),
        [launch]: fixture("anthropic-news/claude-opus-5-5.html"),
        [feature]: fixture("anthropic-news/ebola-response.html"),
      },
      [post, launch, feature]
    )
    const byUrl = Object.fromEntries(entries.map((e) => [e.url, e]))

    expect(byUrl[post]).toMatchObject({
      guid: post,
      title: "Expanding the tide watch",
      publishedAt: new Date("2026-10-06T00:00:00.000Z"),
    })
    expect(byUrl[post].summary).toStartWith(
      "We’re launching a new, expanded tide watch"
    )
    expect(byUrl[post].contentHtml).toContain(
      "launching a new, expanded version of our tide watch"
    )
    expect(byUrl[post].contentHtml).toContain(
      "Full details on each shift can be found in our"
    )

    // No published time: the list tile's date.
    expect(byUrl[launch]).toMatchObject({
      title: "Introducing the Sample Lamp 5.5",
      publishedAt: new Date("2026-09-22T00:00:00.000Z"),
    })
    expect(byUrl[launch].contentHtml).toContain(
      "the first lamp in our new invented 5.5 range"
    )
    expect(byUrl[launch].contentHtml).toContain("wick guide for details.")

    // No body and no published time: summary only, dated by its row.
    expect(byUrl[feature]).toMatchObject({
      title: "The Weather Report",
      publishedAt: new Date("2026-09-21T00:00:00.000Z"),
    })
    expect(byUrl[feature].summary).toStartWith("A rare autumn storm")
    expect(byUrl[feature].contentHtml).toBe(byUrl[feature].summary)

    for (const entry of entries) {
      expect(entry.contentHtml).not.toContain("Try the sample app")
      expect(entry.contentHtml).not.toContain("Invented terms and notices")
      expect(entry.contentHtml).not.toContain("<script")
    }
  })
})
