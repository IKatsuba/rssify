import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { parseFeed } from "@/lib/ingest/parse"
import { SafeFetchError, type SafeFetch } from "@/lib/ingest/safe-fetch"

import { cursorBlog, LAYOUT_CHANGED } from "./cursor-blog"
import { SourceStatusError } from "./types"

const FIXTURES = join(import.meta.dir, "../test/fixtures")
const fixture = (path: string) => readFileSync(join(FIXTURES, path), "utf8")

const LIST = "https://cursor.com/blog"
const post = (slug: string) => `https://cursor.com/blog/${slug}`

// The list page's own posts, in document order (measured on the fixture).
const LIST_POSTS = [
  "joining-spacex",
  "git-at-any-scale",
  "improved-token-efficiency",
  "rollouts-and-security-reviewer",
  "projects",
  "self-hosted-machines",
  "firetiger",
  "aiuc-1",
  "builds",
  "grok-4-6",
  "how-cursor-router-works",
  "navan",
  "grab",
  "basis",
  "nokia",
]

type Answer = { status?: number; text?: string; headers?: HeadersInit } | Error

function site(pages: Record<string, Answer>) {
  const calls: string[] = []
  const signals: (AbortSignal | undefined)[] = []
  let inFlight = 0
  let maxInFlight = 0
  const fetch: SafeFetch = async (url, options) => {
    calls.push(url)
    signals.push(options?.deadline)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      await Bun.sleep(1)
      const page = pages[url] ?? { status: 404 }
      if (page instanceof Error) throw page
      return {
        status: page.status ?? 200,
        url,
        headers: new Headers(page.headers),
        text: page.text ?? "",
        kind: "unknown",
      }
    } finally {
      inFlight--
    }
  }
  return {
    fetch,
    calls,
    signals,
    get maxInFlight() {
      return maxInFlight
    },
  }
}

function run(
  fetch: SafeFetch,
  known: string[] = [],
  deadline = new AbortController().signal
) {
  return cursorBlog.fetchEntries({
    fetch,
    known: async (urls) => new Set(urls.filter((url) => known.includes(url))),
    deadline,
  })
}

const realPosts = {
  [LIST]: { text: fixture("feeds/cursor-blog.html") },
  [post("projects")]: { text: fixture("cursor-blog/projects.html") },
  [post("git-at-any-scale")]: {
    text: fixture("cursor-blog/git-at-any-scale.html"),
  },
  [post("self-hosted-machines")]: {
    text: fixture("cursor-blog/self-hosted-machines.html"),
  },
}

const page = (head: string, body = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

describe("cursorBlog", () => {
  test("owns the list page", () => {
    expect(cursorBlog.id).toBe("cursor-blog")
    expect(cursorBlog.matches).toBe(LIST)
  })

  test("reads posts from the saved list and post pages", async () => {
    const known = LIST_POSTS.filter(
      (slug) =>
        !["projects", "git-at-any-scale", "self-hosted-machines"].includes(slug)
    ).map(post)
    const s = site(realPosts)
    const entries = await run(s.fetch, known)

    expect(entries.map((e) => e.url)).toEqual([
      post("git-at-any-scale"),
      post("projects"),
      post("self-hosted-machines"),
    ])
    const [git, projects, machines] = entries
    expect(projects).toMatchObject({
      guid: post("projects"),
      title: "Introducing Projects",
      summary:
        "Projects lets you take on larger bodies of work with a coordinator that maintains context, delegates to subagents, and runs recurring work.",
      publishedAt: new Date("2026-09-10T12:00:00.000Z"),
      author: null,
    })
    expect(projects.contentHtml).toContain("launching Projects in Cursor")
    expect(machines.title).toBe("Run cloud agents on machines you manage")
    expect(machines.publishedAt).toEqual(new Date("2026-09-02T12:00:00.000Z"))
    // No meta description: the summary comes from the content, as a parsed
    // feed's entry without one would.
    expect(git.title).toBe("Git at any scale")
    expect(git.summary).toStartWith("Hosting Git repositories at scale")
    expect(git.contentHtml).not.toContain("<script")
  })

  test("drops off-site, non-blog and duplicate links, keeping document order", async () => {
    const s = site({ [LIST]: realPosts[LIST] })
    const asked: string[][] = []
    await cursorBlog.fetchEntries({
      fetch: s.fetch,
      known: async (urls) => {
        asked.push(urls)
        return new Set(urls)
      },
      deadline: new AbortController().signal,
    })
    expect(asked).toEqual([LIST_POSTS.map(post)])
    expect(s.calls).toEqual([LIST])
  })

  test("resolves relative and absolute same-site links and skips the rest", async () => {
    const list = page(
      "",
      `<a href="/blog/a?ref=x#top"><article>A</article></a>` +
        `<article><a href="https://cursor.com/blog/b">B</a></article>` +
        `<article><a href="https://cursor.com/blog/a">A again</a></article>` +
        `<article><a href="https://evil.example/blog/c">C</a></article>` +
        `<article><a href="http://cursor.com/blog/d">D</a></article>` +
        `<article><a href="/changelog/e">E</a></article>` +
        `<article><a href="/blog/">list</a></article>` +
        `<article>no link</article>`
    )
    const s = site({ [LIST]: { text: list } })
    const entries = await run(s.fetch)
    expect(entries).toEqual([])
    expect(s.calls).toEqual([LIST, post("a"), post("b")])
  })

  test("a list without posts is a layout change", async () => {
    for (const text of [
      page("", "<main>client-rendered</main>"),
      page("", `<article><a href="https://x.ai/news">x</a></article>`),
    ]) {
      const s = site({ [LIST]: { text } })
      expect(run(s.fetch)).rejects.toThrow(LAYOUT_CHANGED)
    }
  })

  test("a non-2xx list page throws its status and headers", async () => {
    const s = site({
      [LIST]: { status: 429, headers: { "retry-after": "120" } },
    })
    const error = await run(s.fetch).catch((e) => e)
    expect(error).toBeInstanceOf(SourceStatusError)
    expect(error.status).toBe(429)
    expect(error.headers.get("retry-after")).toBe("120")
  })

  test("a list fetch error passes through", async () => {
    const s = site({ [LIST]: new SafeFetchError("blocked", "no") })
    expect(run(s.fetch)).rejects.toBeInstanceOf(SafeFetchError)
  })

  test("fetches at most 10 unknown posts, 4 at a time, under the deadline", async () => {
    const slugs = Array.from({ length: 14 }, (_, i) => `p${i}`)
    const list = page(
      "",
      slugs
        .map((s) => `<a href="/blog/${s}"><article>${s}</article></a>`)
        .join("")
    )
    const pages: Record<string, Answer> = { [LIST]: { text: list } }
    for (const slug of slugs) {
      pages[post(slug)] = {
        text: page(`<meta property="og:title" content="${slug} · Cursor">`),
      }
    }
    const s = site(pages)
    const deadline = new AbortController().signal
    const entries = await run(s.fetch, [post("p1")], deadline)

    const expected = slugs.filter((s) => s !== "p1").slice(0, 10)
    expect(entries.map((e) => e.title)).toEqual(expected)
    expect(s.calls.slice(1).sort()).toEqual(expected.map(post).sort())
    expect(s.maxInFlight).toBe(4)
    expect(s.signals.every((signal) => signal === deadline)).toBe(true)
  })

  test("strips only a trailing ' · Cursor' and keeps titles literal", async () => {
    const titles = ["A · Cursor · Cursor", "Cursor · tips", "<b> & co · Cursor"]
    const list = page(
      "",
      titles
        .map((_, i) => `<a href="/blog/t${i}"><article></article></a>`)
        .join("")
    )
    const pages: Record<string, Answer> = { [LIST]: { text: list } }
    titles.forEach((title, i) => {
      const attr = title.replace(/&/g, "&amp;").replace(/</g, "&lt;")
      pages[post(`t${i}`)] = {
        text: page(`<meta property="og:title" content="${attr}">`),
      }
    })
    const entries = await run(site(pages).fetch)
    expect(entries.map((e) => e.title)).toEqual([
      "A · Cursor",
      "Cursor · tips",
      "<b> & co",
    ])
  })

  test("dates come from published_time, then time[datetime], then the list", async () => {
    const list = page(
      "",
      ["meta", "time", "list", "bad", "none"]
        .map(
          (slug) =>
            `<a href="/blog/${slug}"><article>` +
            (slug === "none"
              ? ""
              : `<time datetime="2026-01-0${slug.length}T00:00:00Z"></time>`) +
            `</article></a>`
        )
        .join("")
    )
    const meta = `<meta property="article:published_time" content="2026-05-05T00:00:00Z">`
    const time = `<time datetime="2026-06-06T00:00:00Z"></time>`
    const s = site({
      [LIST]: { text: list },
      [post("meta")]: { text: page(meta, time) },
      [post("time")]: { text: page("", time) },
      [post("list")]: { text: page("") },
      [post("bad")]: {
        text: page(
          `<meta property="article:published_time" content="soon">`,
          `<time datetime="later"></time>`
        ),
      },
      [post("none")]: { text: page("") },
    })
    const entries = await run(s.fetch)
    expect(
      entries.map((e) => [e.url, e.publishedAt?.toISOString() ?? null])
    ).toEqual([
      [post("meta"), "2026-05-05T00:00:00.000Z"],
      [post("time"), "2026-06-06T00:00:00.000Z"],
      [post("list"), "2026-01-04T00:00:00.000Z"],
      [post("bad"), "2026-01-03T00:00:00.000Z"],
      [post("none"), null],
    ])
  })

  test("a post that fails or answers non-2xx is skipped this run", async () => {
    const list = page(
      "",
      ["ok", "down", "gone", "boom"]
        .map((s) => `<a href="/blog/${s}"><article></article></a>`)
        .join("")
    )
    const s = site({
      [LIST]: { text: list },
      [post("ok")]: { text: page(`<meta property="og:title" content="Fine">`) },
      [post("down")]: new SafeFetchError("unreachable", "down"),
      [post("gone")]: { status: 500 },
      [post("boom")]: { status: 404 },
    })
    const entries = await run(s.fetch)
    expect(entries.map((e) => e.url)).toEqual([post("ok")])
  })

  test("entries match what parse gives for the same item", async () => {
    const s = site({
      [LIST]: { text: page("", `<a href="/blog/x"><article></article></a>`) },
      [post("x")]: {
        text: page(
          `<meta property="og:title" content="X &amp; Y · Cursor">` +
            `<meta name="description" content="About X">` +
            `<meta property="article:published_time" content="2026-02-02T00:00:00Z">`,
          `<div class="prose--blog"><p>Hi <a href="/docs">docs</a></p><script>x</script></div>`
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
    expect(entry.contentHtml).toContain('href="https://cursor.com/docs"')
  })
})
