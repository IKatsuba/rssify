import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import { SafeFetchError, type SafeFetch } from "@/lib/ingest/safe-fetch"
import { refreshFeed } from "@/lib/ingest/refresh"
import { subscribe } from "@/lib/reader"
import { db } from "@/test/db"

import { cursorBlog } from "./cursor-blog"
import { SourceStatusError } from "./types"

const listUrl = "https://cursor.com/blog"
const postUrl = (slug: string) => `${listUrl}/${slug}`
const savedPost = readFileSync(
  join(import.meta.dir, "../test/fixtures/cursor-blog/projects.html"),
  "utf8"
)
const list = (slugs: string[]) =>
  slugs
    .map((slug) => `<a href="/blog/${slug}"><article></article></a>`)
    .join("")
const answer = (url: string, text: string, status = 200) => ({
  url,
  text,
  status,
  headers: new Headers(),
  kind: "unknown" as const,
})
const run = (fetch: SafeFetch) =>
  cursorBlog.fetchEntries({
    url: listUrl,
    fetch,
    known: async () => new Set(),
    deadline: new AbortController().signal,
  })

describe("cursor-blog tester edge cases", () => {
  test("three all-unreadable refreshes mark failing; recovery and a repeated refresh keep one entry", async () => {
    const now = new Date("2026-10-22T10:00:00Z")
    const feed = await db.feed.create({
      data: {
        url: listUrl,
        pluginId: "cursor-blog",
        title: "Cursor blog",
        siteUrl: listUrl,
      },
    })
    let readable = false
    const calls: string[] = []
    const fetch: SafeFetch = async (url) => {
      calls.push(url)
      return url === listUrl
        ? answer(url, list(["projects"]))
        : answer(url, readable ? savedPost : "", readable ? 200 : 404)
    }
    for (let failures = 1; failures <= 3; failures++) {
      expect(await refreshFeed(feed.id, { fetch, now })).toEqual({
        outcome: "failed",
        error: "none of the new posts could be read",
      })
      expect(
        await db.feed.findUniqueOrThrow({ where: { id: feed.id } })
      ).toMatchObject({
        failureCount: failures,
        status: failures === 3 ? "failing" : "ok",
        nextFetchAt: new Date(now.getTime() + 2 ** failures * 3_600_000),
        lastSuccessAt: null,
      })
    }
    readable = true
    expect(await refreshFeed(feed.id, { fetch, now })).toEqual({
      outcome: "ok",
      stored: 1,
    })
    expect(
      await db.feed.findUniqueOrThrow({ where: { id: feed.id } })
    ).toMatchObject({
      failureCount: 0,
      status: "ok",
      lastError: null,
      lastSuccessAt: now,
      title: "Cursor blog",
      siteUrl: listUrl,
    })
    calls.length = 0
    expect(await refreshFeed(feed.id, { fetch, now })).toEqual({
      outcome: "ok",
      stored: 0,
    })
    expect(calls).toEqual([listUrl])
    expect(await db.entry.count({ where: { feedId: feed.id } })).toBe(1)
    expect(
      await db.entry.findFirstOrThrow({ where: { feedId: feed.id } })
    ).toMatchObject({
      guid: postUrl("projects"),
      title: "Introducing Projects",
    })
  })

  test("an unreadable built-in add writes nothing and a later successful add can recover", async () => {
    await db.user.create({
      data: {
        id: "cursor-tester",
        name: "Tester",
        email: "cursor-tester@example.com",
      },
    })
    let readable = false
    const fetch: SafeFetch = async (url) =>
      url === listUrl
        ? answer(url, list(["projects"]))
        : answer(url, readable ? savedPost : "", readable ? 200 : 500)
    expect(
      await subscribe("cursor-tester", { source: "cursor-blog" }, { fetch })
    ).toEqual({ ok: false, code: "not_found" })
    expect(await db.feed.count()).toBe(0)
    expect(await db.subscription.count()).toBe(0)
    expect(await db.entry.count()).toBe(0)
    readable = true
    expect(
      await subscribe("cursor-tester", { source: "cursor-blog" }, { fetch })
    ).toMatchObject({ ok: true, existed: false })
    expect(
      await db.feed.findUniqueOrThrow({ where: { url: listUrl } })
    ).toMatchObject({
      title: "Cursor blog",
      siteUrl: listUrl,
      pluginId: "cursor-blog",
    })
    expect(await db.entry.count()).toBe(1)
  })

  test("missing body is a summary-only success and duplicate query links are fetched once", async () => {
    const calls: string[] = []
    const entries = await run(async (url) => {
      calls.push(url)
      return answer(
        url,
        url === listUrl
          ? list(["summary?ref=first#top", "summary?ref=second"])
          : '<meta property="og:title" content="Summary · Cursor"><meta name="description" content="Still readable">'
      )
    })
    expect(calls).toEqual([listUrl, postUrl("summary")])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      title: "Summary",
      summary: "Still readable",
      contentHtml: "Still readable",
    })
  })

  test("preserves list status without looking up or fetching posts", async () => {
    for (const status of [304, 404, 410, 429, 500]) {
      const calls: string[] = []
      const headers = new Headers({ "retry-after": "7200" })
      let lookups = 0
      const result = await cursorBlog
        .fetchEntries({
          url: listUrl,
          fetch: async (url) => {
            calls.push(url)
            return { ...answer(url, list(["projects"]), status), headers }
          },
          known: async () => {
            lookups++
            return new Set()
          },
          deadline: new AbortController().signal,
        })
        .catch((error) => error)
      expect(result).toBeInstanceOf(SourceStatusError)
      expect(result.status).toBe(status)
      expect(result.headers).toBe(headers)
      expect(calls).toEqual([listUrl])
      expect(lookups).toBe(0)
    }
  })

  test("four blocked requests fill the pool and completion order does not reorder entries", async () => {
    const slugs = ["one", "two", "three", "four", "five"]
    const started: string[] = []
    const releases = new Map<string, () => void>()
    let waveReady!: () => void
    const firstWave = new Promise<void>((resolve) => (waveReady = resolve))
    let fifthReady!: () => void
    const fifth = new Promise<void>((resolve) => (fifthReady = resolve))
    const pending = run(async (url) => {
      if (url === listUrl) return answer(url, list(slugs))
      started.push(url)
      await new Promise<void>((resolve) => {
        releases.set(url, resolve)
        if (started.length === 4) waveReady()
        if (started.length === 5) fifthReady()
      })
      return answer(url, savedPost)
    })
    await firstWave
    expect(started).toEqual(slugs.slice(0, 4).map(postUrl))
    releases.get(postUrl("four"))!()
    await fifth
    for (const slug of ["five", "three", "two", "one"]) {
      releases.get(postUrl(slug))!()
    }
    expect((await pending).map((entry) => entry.guid)).toEqual(
      slugs.map(postUrl)
    )
  })

  test("a timed-out post is retried on the next run while successful posts become known", async () => {
    const known = new Set<string>()
    const calls: string[] = []
    let timeout = true
    const fetch: SafeFetch = async (url) => {
      calls.push(url)
      if (url === listUrl) return answer(url, list(["projects", "retry"]))
      if (url === postUrl("retry") && timeout) {
        throw new SafeFetchError("unreachable", "deadline exceeded")
      }
      return answer(url, savedPost)
    }
    const ctx = {
      url: listUrl,
      fetch,
      known: async (urls: string[]) =>
        new Set(urls.filter((url) => known.has(url))),
      deadline: new AbortController().signal,
    }
    const first = await cursorBlog.fetchEntries(ctx)
    expect(first.map((entry) => entry.guid)).toEqual([postUrl("projects")])
    first.forEach((entry) => known.add(entry.guid))
    timeout = false
    calls.length = 0
    const second = await cursorBlog.fetchEntries(ctx)
    expect(second.map((entry) => entry.guid)).toEqual([postUrl("retry")])
    expect(calls).toEqual([listUrl, postUrl("retry")])
  })

  test("uses only the first prose block and applies content and summary limits", async () => {
    const html = `<meta property="og:title" content="Large · Cursor">
      <meta name="description" content="${"😀".repeat(400)}">
      <div class="prose--blog"><p>${"😀".repeat(60000)}</p><script>bad()</script></div>
      <div class="prose--blog">SECOND BLOCK</div>`
    const [entry] = await run(async (url) =>
      answer(url, url === listUrl ? list(["large"]) : html)
    )
    expect(Array.from(entry.summary ?? "")).toHaveLength(300)
    expect(Buffer.byteLength(entry.contentHtml ?? "")).toBeLessThanOrEqual(
      200 * 1024
    )
    expect(entry.contentHtml).toEndWith("</p>")
    expect(entry.contentHtml).not.toContain("\uFFFD")
    expect(entry.contentHtml).not.toContain("SECOND BLOCK")
    expect(entry.contentHtml).not.toContain("<script")
  })
})
