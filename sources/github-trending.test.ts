import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type { SafeFetch, SafeFetchOptions } from "@/lib/ingest/safe-fetch"

import { githubTrending } from "./github-trending"
import { LAYOUT_CHANGED } from "./list-posts"
import { SourceStatusError } from "./types"

const fixture = (name: string) =>
  readFileSync(
    join(import.meta.dir, "../test/fixtures/github-trending", name),
    "utf8"
  )

const JS_MONTHLY = "https://github.com/trending/javascript?since=monthly"
const canonical = (url: string) => githubTrending.canonical(new URL(url))

// A fake fetch answering one page; tests never reach github.com.
function page(text: string, status = 200, headers?: HeadersInit) {
  const calls: { url: string; options?: SafeFetchOptions }[] = []
  const fetch: SafeFetch = async (url, options) => {
    calls.push({ url, options })
    return { status, url, headers: new Headers(headers), text, kind: "unknown" }
  }
  return { fetch, calls }
}

function run(fetch: SafeFetch, url = JS_MONTHLY, deadline?: AbortSignal) {
  return githubTrending.fetchEntries({
    url,
    fetch,
    known: async () => new Set(),
    deadline: deadline ?? new AbortController().signal,
  })
}

const row = (inner: string) =>
  `<html><body><article class="Box-row">${inner}</article></body></html>`

describe("githubTrending.canonical", () => {
  test("every accepted spelling reaches the canonical URL", () => {
    const cases: [string, string][] = [
      [
        "https://github.com/trending",
        "https://github.com/trending?since=daily",
      ],
      [
        "http://github.com/trending/",
        "https://github.com/trending?since=daily",
      ],
      ["https://www.github.com/trending/JavaScript?since=monthly", JS_MONTHLY],
      ["https://github.com/trending/javascript/?since=monthly", JS_MONTHLY],
      [
        "https://github.com/trending/javascript?since=monthly&spoken_language_code=",
        JS_MONTHLY,
      ],
      [
        "https://github.com/trending/javascript?utm_source=x&since=monthly&l=1",
        JS_MONTHLY,
      ],
      [
        "https://github.com/trending/typescript",
        "https://github.com/trending/typescript?since=daily",
      ],
      [
        "https://github.com/trending/C++?since=weekly&spoken_language_code=zh",
        "https://github.com/trending/c%2B%2B?since=weekly&spoken_language_code=zh",
      ],
      [
        "https://github.com/trending/c%2b%2b?since=weekly",
        "https://github.com/trending/c%2B%2B?since=weekly",
      ],
      [
        "https://github.com/trending?spoken_language_code=zh",
        "https://github.com/trending?since=daily&spoken_language_code=zh",
      ],
    ]
    for (const [input, expected] of cases) {
      expect([input, canonical(input)]).toEqual([input, expected])
      expect(canonical(expected)).toBe(expected)
    }
  })

  test("refuses what GitHub would not show as asked, and other pages", () => {
    for (const input of [
      "https://github.com/trending?since=yearly",
      "https://github.com/trending/javascript?since=",
      "https://github.com/trending/javascript?since=Monthly",
      "https://github.com/trending?since=toString",
      "https://github.com/trending?since=constructor",
      "https://github.com/trending?since=__proto__",
      "https://github.com/trending?since=hasOwnProperty",
      "https://github.com/trending/developers",
      "https://github.com/trending/developers/javascript?since=monthly",
      "https://github.com/trending/%zz",
      "https://github.com/trending//",
      "https://github.com/trendings",
      "https://github.com/explore",
      "https://github.com/vercel/next.js",
      "https://github.com.evil.invalid/trending",
      "https://evil.invalid/trending",
      "https://gist.github.com/trending",
      "http://github.com:8080/trending",
    ]) {
      expect([input, canonical(input)]).toEqual([input, null])
    }
  })
})

describe("githubTrending.title", () => {
  test("is built from the URL alone", () => {
    expect(githubTrending.title!(JS_MONTHLY)).toBe(
      "GitHub trending · javascript · this month"
    )
    expect(
      githubTrending.title!("https://github.com/trending?since=daily")
    ).toBe("GitHub trending · today")
    expect(
      githubTrending.title!(
        "https://github.com/trending/c%2B%2B?since=weekly&spoken_language_code=zh"
      )
    ).toBe("GitHub trending · c++ · this week · zh")
  })
})

describe("githubTrending.fetchEntries", () => {
  test("reads every row of the saved page with one GET", async () => {
    const deadline = new AbortController().signal
    const s = page(fixture("javascript-monthly.html"))
    const entries = await run(s.fetch, JS_MONTHLY, deadline)

    expect(s.calls).toEqual([{ url: JS_MONTHLY, options: { deadline } }])
    expect(entries).toHaveLength(17)
    expect(entries.map((e) => e.title).slice(0, 3)).toEqual([
      "cloudflare/security-audit-skill",
      "affaan-m/ECC",
      "addyosmani/agent-skills",
    ])
    expect(entries[0]).toEqual({
      guid: "https://github.com/cloudflare/security-audit-skill",
      url: "https://github.com/cloudflare/security-audit-skill",
      title: "cloudflare/security-audit-skill",
      author: null,
      publishedAt: null,
      summary:
        "A coding-agent skill for multi-phase security audits with independently verified, machine-readable findings",
      contentHtml:
        "<p>A coding-agent skill for multi-phase security audits with independently verified, machine-readable findings</p>" +
        "<p>JavaScript · 38,199 stars · 2,385 forks · 16,694 stars this month</p>",
    })
    // The guid is lowercased; the link keeps GitHub's casing.
    expect(entries[1]).toMatchObject({
      guid: "https://github.com/affaan-m/ecc",
      url: "https://github.com/affaan-m/ECC",
    })
    expect(entries.every((e) => e.publishedAt === null)).toBe(true)
  })

  test("a row without a description keeps its stats", async () => {
    const entries = await run(page(fixture("javascript-monthly.html")).fetch)
    const taxonomy = entries.find(
      (e) => e.title === "withmarbleapp/os-taxonomy"
    )
    expect(taxonomy).toMatchObject({
      summary:
        "JavaScript · 7,158 stars · 1,153 forks · 2,478 stars this month",
      contentHtml:
        "<p>JavaScript · 7,158 stars · 1,153 forks · 2,478 stars this month</p>",
    })
  })

  test("a row without a language leaves the language out", async () => {
    const url = "https://github.com/trending/unknown?since=weekly"
    const entries = await run(page(fixture("unknown-weekly.html")).fetch, url)
    expect(entries).toHaveLength(7)
    expect(entries[0]).toMatchObject({
      guid: "https://github.com/mlabonne/llm-course",
      title: "mlabonne/llm-course",
    })
    expect(entries[0].contentHtml).toEndWith(
      "<p>84,592 stars · 9,834 forks · 1,029 stars this week</p>"
    )
  })

  test("escapes what the row says", async () => {
    const entries = await run(
      page(
        row(
          `<h2><a href="/a/b">a / b</a></h2>` +
            `<p>&lt;img src=x onerror=alert(1)&gt; &amp; more</p>` +
            `<span itemprop="programmingLanguage">&lt;b&gt;C&lt;/b&gt;</span>`
        )
      ).fetch
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].contentHtml).not.toContain("<img")
    expect(entries[0].contentHtml).not.toContain("<b>")
    expect(entries[0].contentHtml).toContain("&lt;img src=x")
    expect(entries[0].summary).toBe("<img src=x onerror=alert(1)> & more")
  })

  test("a blankslate page is an empty list", async () => {
    expect(await run(page(fixture("blankslate.html")).fetch)).toEqual([])
  })

  test("no rows and no blankslate is a changed layout", async () => {
    await expect(
      run(page("<html><body>Hi</body></html>").fetch)
    ).rejects.toThrow(LAYOUT_CHANGED)
    // Rows whose repo link is gone count as no rows.
    await expect(run(page(row("<h2>no link</h2>")).fetch)).rejects.toThrow(
      LAYOUT_CHANGED
    )
  })

  test("a non-2xx answer is a SourceStatusError", async () => {
    const error = await run(
      page("", 429, { "retry-after": "120" }).fetch
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SourceStatusError)
    expect((error as SourceStatusError).status).toBe(429)
    expect((error as SourceStatusError).headers.get("retry-after")).toBe("120")
  })
})
