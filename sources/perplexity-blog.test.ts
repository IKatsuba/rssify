import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { parseFeed } from "@/lib/ingest/parse"
import type { SafeFetch } from "@/lib/ingest/safe-fetch"

import { NONE_READ } from "./list-posts"
import { LAYOUT_CHANGED, perplexityBlog } from "./perplexity-blog"

const FIXTURES = join(import.meta.dir, "../test/fixtures/perplexity-blog")
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8")

const BLOG = "https://www.perplexity.ai/hub/blog"
const RESEARCH = `${BLOG}/category/research`
const DEVELOPERS = `${BLOG}/category/developers`
const post = (slug: string) => `${BLOG}/${slug}`

type Answer = { status?: number; text?: string }

function site(pages: Record<string, Answer>) {
  const calls: string[] = []
  const fetch: SafeFetch = async (url) => {
    calls.push(url)
    const page = pages[url] ?? { status: 404 }
    return {
      status: page.status ?? 200,
      url,
      headers: new Headers(),
      text: page.text ?? "",
      kind: "unknown",
    }
  }
  return { fetch, calls }
}

function run(fetch: SafeFetch, url = RESEARCH, known: string[] = []) {
  return perplexityBlog.fetchEntries({
    url,
    fetch,
    known: async (urls) => new Set(urls.filter((u) => known.includes(u))),
    deadline: new AbortController().signal,
  })
}

const page = (head: string, body = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
const column = (html: string) =>
  `<article><div class="mx-auto max-w-[760px]">${html}</div></article>`

describe("perplexityBlog", () => {
  test("owns exactly the research and developers categories", () => {
    expect(perplexityBlog.id).toBe("perplexity-blog")
    for (const url of [RESEARCH, DEVELOPERS]) {
      expect(perplexityBlog.canonical(new URL(url))).toBe(url)
    }
    for (const other of [
      `${RESEARCH}/`,
      `${RESEARCH}?page=2`,
      `${BLOG}/category/ideas`,
      `${BLOG}/category/news`,
      BLOG,
      "https://perplexity.ai/hub/blog/category/research",
      "http://www.perplexity.ai/hub/blog/category/research",
    ]) {
      expect(perplexityBlog.canonical(new URL(other))).toBeNull()
    }
  })

  test("lists the category's posts once each, in document order", async () => {
    const s = site({ [RESEARCH]: { text: fixture("research.html") } })
    const asked: string[][] = []
    await perplexityBlog.fetchEntries({
      url: RESEARCH,
      fetch: s.fetch,
      known: async (urls) => {
        asked.push(urls)
        return new Set(urls)
      },
      deadline: new AbortController().signal,
    })
    expect(asked).toEqual([
      [
        "tide-pools",
        "kite-strings",
        "paper-boats",
        "sand-timers",
        "rain-gauges",
      ].map(post),
    ])
    expect(s.calls).toEqual([RESEARCH])
  })

  test("reads a post from the fixture", async () => {
    const s = site({
      [RESEARCH]: { text: fixture("research.html") },
      [post("tide-pools")]: { text: fixture("tide-pools.html") },
    })
    const known = ["kite-strings", "paper-boats", "sand-timers", "rain-gauges"]
    const [entry, ...rest] = await run(s.fetch, RESEARCH, known.map(post))
    expect(rest).toEqual([])
    expect(entry).toMatchObject({
      guid: post("tide-pools"),
      url: post("tide-pools"),
      title: "Tide pools at low water",
      summary:
        "How invented crabs, a bucket and a tide table keep a tide pool survey honest.",
      publishedAt: new Date("2026-10-21T00:00:00.000Z"),
    })
    expect(entry.contentHtml).toContain("Counting crabs in a tide pool")
    expect(entry.contentHtml).toContain(`href="${post("rain-gauges")}"`)
    expect(entry.contentHtml).not.toContain("Share this post")
    expect(entry.contentHtml).not.toContain("<h1")
  })

  test("reads the category it is given", async () => {
    const s = site({
      [DEVELOPERS]: {
        text: page("", `<a href="/hub/blog/api-notes">API notes</a>`),
      },
      [post("api-notes")]: { text: page("", column("<p>Hi</p>")) },
    })
    const entries = await run(s.fetch, DEVELOPERS)
    expect(entries.map((e) => e.url)).toEqual([post("api-notes")])
    expect(s.calls).toEqual([DEVELOPERS, post("api-notes")])
  })

  test("dates come from the post, then the list, the first dated link winning", async () => {
    const list = page(
      "",
      `<a href="/hub/blog/a">A</a>` +
        `<a href="/hub/blog/a"><time dateTime="2026-01-01">x</time></a>` +
        `<a href="/hub/blog/a"><time dateTime="2026-02-02">x</time></a>` +
        `<a href="/hub/blog/b"><time dateTime="2026-03-03">x</time></a>` +
        `<a href="/hub/blog/c"><time dateTime="soon">x</time></a>`
    )
    const s = site({
      [RESEARCH]: { text: list },
      [post("a")]: { text: page("", column("")) },
      [post("b")]: {
        text: page(
          "",
          `<article><header><time dateTime="2026-04-04">x</time></header>` +
            `<div class="max-w-[760px]"></div></article>`
        ),
      },
      [post("c")]: { text: page("", column("")) },
    })
    const entries = await run(s.fetch)
    expect(
      entries.map((e) => [e.url, e.publishedAt?.toISOString() ?? null])
    ).toEqual([
      [post("a"), "2026-01-01T00:00:00.000Z"],
      [post("b"), "2026-04-04T00:00:00.000Z"],
      [post("c"), null],
    ])
  })

  test("a list without posts is a layout change", async () => {
    const list = page("", `<a href="/hub/blog/category/ideas">Ideas</a>`)
    await expect(
      run(site({ [RESEARCH]: { text: list } }).fetch)
    ).rejects.toThrow(LAYOUT_CHANGED)
  })

  test("a post without the body column is skipped", async () => {
    const s = site({
      [RESEARCH]: {
        text: page(
          "",
          `<a href="/hub/blog/a">A</a><a href="/hub/blog/b">B</a>`
        ),
      },
      [post("a")]: { text: page("", "<article><p>moved</p></article>") },
      [post("b")]: { text: page("", column("<p>Hi</p>")) },
    })
    const entries = await run(s.fetch)
    expect(entries.map((e) => e.url)).toEqual([post("b")])
  })

  test("every post without the body column is a layout change", async () => {
    const s = site({
      [RESEARCH]: {
        text: page(
          "",
          `<a href="/hub/blog/a">A</a><a href="/hub/blog/b">B</a>`
        ),
      },
      [post("a")]: { text: page("", "<article><p>moved</p></article>") },
      [post("b")]: { text: page("", "<article><p>moved</p></article>") },
    })
    await expect(run(s.fetch)).rejects.toThrow(LAYOUT_CHANGED)
  })

  test("posts that do not answer are skipped", async () => {
    const s = site({
      [RESEARCH]: { text: page("", `<a href="/hub/blog/a">A</a>`) },
    })
    await expect(run(s.fetch)).rejects.toThrow(NONE_READ)
  })

  test("entries match what parse gives for the same item", async () => {
    const s = site({
      [RESEARCH]: { text: page("", `<a href="/hub/blog/x">X</a>`) },
      [post("x")]: {
        text: page(
          `<meta property="og:title" content="X And Y">` +
            `<meta name="description" content="About X">`,
          `<article><header><h1>X &amp; Y</h1><time dateTime="2026-02-02">x</time></header>` +
            `<div class="max-w-[760px]"><p>Hi <a href="/docs">docs</a></p><script>x</script></div></article>`
        ),
      },
    })
    const [entry] = await run(s.fetch)
    const rss =
      `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>t</title><item>` +
      `<guid>${post("x")}</guid><link>${post("x")}</link>` +
      `<title>X &amp;amp; Y</title><description>About X</description>` +
      `<pubDate>Mon, 02 Feb 2026 00:00:00 GMT</pubDate>` +
      `<content:encoded><![CDATA[<p>Hi <a href="/docs">docs</a></p><script>x</script>]]></content:encoded>` +
      `</item></channel></rss>`
    const [parsed] = parseFeed(rss, post("x")).entries
    expect(entry).toEqual(parsed)
  })
})
