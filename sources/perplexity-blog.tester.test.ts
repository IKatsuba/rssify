import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { SafeFetchError, type SafeFetch } from "@/lib/ingest/safe-fetch"

import { LAYOUT_CHANGED, NONE_READ } from "./list-posts"
import { perplexityBlog } from "./perplexity-blog"
import { SourceStatusError } from "./types"

const blog = "https://www.perplexity.ai/hub/blog"
const research = `${blog}/category/research`
const developers = `${blog}/category/developers`
const postUrl = (slug: string) => `${blog}/${slug}`
const savedPost = readFileSync(
  join(import.meta.dir, "../test/fixtures/perplexity-blog/tide-pools.html"),
  "utf8"
)
const list = (slugs: string[]) =>
  slugs.map((slug) => `<a href="${postUrl(slug)}">Post</a>`).join("")
const answer = (url: string, text: string, status = 200) => ({
  url,
  text,
  status,
  headers: new Headers(),
  kind: "unknown" as const,
})
const run = (fetch: SafeFetch, url = research) =>
  perplexityBlog.fetchEntries({
    url,
    fetch,
    known: async () => new Set(),
    deadline: new AbortController().signal,
  })
const withPost = (html: string, listHtml = list(["tide-pools"])) =>
  run(async (url) => answer(url, url === research ? listHtml : html))

describe("perplexity-blog tester edge cases", () => {
  test("accepts only the two exact category URLs", () => {
    for (const url of [research, developers]) {
      expect(perplexityBlog.canonical(new URL(url))).toBe(url)
      for (const suffix of ["/", "?page=1", "#top"]) {
        expect(perplexityBlog.canonical(new URL(url + suffix))).toBeNull()
      }
    }
    for (const url of [
      `${blog}/category/ideas`,
      `${blog}/category/news`,
      `${blog}/category/Research`,
      blog,
      postUrl("tide-pools"),
      research.replace("www.perplexity.ai", "perplexity.ai"),
      research.replace("www.perplexity.ai", "www.perplexity.ai.example"),
      research.replace("www.perplexity.ai", "elsewhere.example"),
      research.replace("https:", "http:"),
    ]) {
      expect(perplexityBlog.canonical(new URL(url))).toBeNull()
    }
  })

  test("skips category links and fetches duplicate links once, retaining a later list date", async () => {
    const calls: string[] = []
    const undated = savedPost.replace(/<time\b[^>]*>.*?<\/time>/g, "")
    const entries = await run(async (url) => {
      calls.push(url)
      return answer(
        url,
        url === research
          ? `<a href="/hub/blog/category/research">Research</a>
            <a href="/hub/blog/category/developers">Developers</a>
            <a href="/hub/blog/category/ideas">Ideas</a>
            <a href="/hub/blog/tide-pools?ref=hero#top">Featured</a>
            <a href="/hub/blog/tide-pools"><time datetime="invalid">Unknown</time></a>
            <a href="${postUrl("tide-pools")}?ref=list"><time datetime="2026-08-09">Date</time></a>
            <a href="/hub/blog/tide-pools"><time datetime="2026-09-10">Later</time></a>
            <a href="https://elsewhere.example/hub/blog/foreign">Foreign</a>`
          : undated
      )
    })
    expect(calls).toEqual([research, postUrl("tide-pools")])
    expect(entries).toHaveLength(1)
    expect(entries[0].publishedAt).toEqual(new Date("2026-08-09T00:00:00Z"))
  })

  test("h1 wins over og:title, which is used for absent and blank h1", async () => {
    const [headed] = await withPost(savedPost)
    expect(headed.title).toBe("Tide pools at low water")
    for (const heading of ["", "<h1> \n </h1>"]) {
      const [fallback] = await withPost(
        savedPost.replace(/<h1\b[^>]*>.*?<\/h1>/, heading)
      )
      expect(fallback.title).toBe("Tide Pools at Low Water")
    }
  })

  test("post datetime wins; missing, invalid and text-only dates fall back to the list", async () => {
    const datedList = `<a href="${postUrl("tide-pools")}"><time datetime="2026-07-08">List date</time></a>`
    const [dated] = await withPost(savedPost, datedList)
    expect(dated.publishedAt).toEqual(new Date("2026-10-21T00:00:00Z"))
    for (const time of [
      "",
      '<time datetime="not-a-date">October 21, 2026</time>',
      "<time>October 21, 2026</time>",
    ]) {
      const html = savedPost.replace(/<time\b[^>]*>.*?<\/time>/, time)
      const [fallback] = await withPost(html, datedList)
      expect(fallback.publishedAt).toEqual(new Date("2026-07-08T00:00:00Z"))
      const [undated] = await withPost(
        html,
        `<a href="${postUrl("tide-pools")}"><time>July 8, 2026</time></a>`
      )
      expect(undated.publishedAt).toBeNull()
    }
  })

  test("a missing body column is skipped while readable posts keep their order", async () => {
    const entries = await run(async (url) =>
      answer(
        url,
        url === research
          ? list(["first", "missing", "last"])
          : url === postUrl("missing")
            ? '<article><h1>Moved</h1><div class="max-w-[761px]">Body moved</div></article>'
            : savedPost
      )
    )
    expect(entries.map((entry) => entry.guid)).toEqual(
      ["first", "last"].map(postUrl)
    )
  })

  test("all missing columns, including mixed missing and failed responses, report LAYOUT_CHANGED", async () => {
    for (const failedSecond of [false, true]) {
      await expect(
        run(async (url) =>
          url === research
            ? answer(url, list(["missing", "second"]))
            : answer(
                url,
                '<div class="max-w-[760px]">Outside article</div><article><p>No body column</p></article>',
                failedSecond && url === postUrl("second") ? 500 : 200
              )
        )
      ).rejects.toThrow(LAYOUT_CHANGED)
    }
  })

  test("non-answering posts report NONE_READ and do not inherit a previous layout failure", async () => {
    await expect(withPost("<article>Missing column</article>")).rejects.toThrow(
      LAYOUT_CHANGED
    )
    await expect(
      run(async (url) => {
        if (url === research) {
          return answer(url, list(["304", "404", "429", "500", "timeout"]))
        }
        if (url === postUrl("timeout")) {
          throw new SafeFetchError("unreachable", "deadline exceeded")
        }
        return answer(url, savedPost, Number(url.split("/").pop()))
      })
    ).rejects.toThrow(NONE_READ)
  })

  test("list status and retry headers are preserved without fetching posts", async () => {
    for (const status of [304, 404, 429, 500]) {
      const calls: string[] = []
      const headers = new Headers({ "retry-after": "120" })
      const error = await run(async (url) => {
        calls.push(url)
        return { ...answer(url, list(["tide-pools"]), status), headers }
      }).catch((error) => error)
      expect(error).toBeInstanceOf(SourceStatusError)
      expect(error.status).toBe(status)
      expect(error.headers).toBe(headers)
      expect(calls).toEqual([research])
    }
  })
})
