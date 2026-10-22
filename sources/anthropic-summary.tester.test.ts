import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"
import { load } from "cheerio"

import { anthropicEngineering } from "./anthropic"

const LIST = "https://www.anthropic.com/engineering"
const POST =
  "https://www.anthropic.com/research/harness-design-long-running-apps"
const fixture = (name: string) =>
  readFileSync(
    join(import.meta.dir, "../test/fixtures/anthropic-engineering", name),
    "utf8"
  )
const list = fixture("list.html")
const post = fixture("harness-design-long-running-apps.html")
const generic = load(list)('meta[name="description"]').attr("content")!

async function read(
  listHtml: string,
  postHtml: string,
  beforePost?: () => Promise<void>
) {
  return anthropicEngineering.fetchEntries({
    url: LIST,
    deadline: new AbortController().signal,
    known: async (urls) => new Set(urls.filter((url) => url !== POST)),
    fetch: async (url) => {
      if (url !== LIST) {
        expect(url).toBe(POST)
        await beforePost?.()
      }
      return {
        url,
        text: url === LIST ? listHtml : postHtml,
        status: 200,
        headers: new Headers(),
        kind: "unknown",
      }
    },
  })
}

describe("Anthropic summary tester regressions", () => {
  test("generic summaries use only the first paragraph, decode links and entities, and keep literal markup text", async () => {
    const $ = load(post)
    $('meta[name="description"]').attr("content", `  ${generic}  `)
    $("p.post-text")
      .first()
      .html(
        'First <a href="/docs">linked &amp; clear</a> &lt;b&gt;literal&lt;/b&gt;.'
      )
    const [entry] = await read(list, $.html())
    expect(entry.summary).toBe("First linked & clear <b>literal</b>.")
    expect(entry.contentHtml).toContain("linked &amp; clear</a>")
  })

  test("a very long first paragraph uses the shared 300 character limit", async () => {
    const $ = load(post)
    $("p.post-text").first().text("x".repeat(10_000))
    const [entry] = await read(list, $.html())
    expect(entry.summary).toBe("x".repeat(300))
    expect(entry.contentHtml).toContain("x".repeat(10_000))
  })

  test("a later list without description does not inherit an earlier run's default", async () => {
    await read(list, post)
    const $ = load(list)
    $('meta[name="description"]').remove()
    const [entry] = await read($.html(), post)
    expect(entry.summary).toBe(generic)
  })

  test("overlapping runs keep their own list description while a post is held", async () => {
    let entered!: () => void
    let release!: () => void
    const atPost = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = read(list, post, async () => {
      entered()
      await held
    })
    await atPost
    try {
      const $ = load(list)
      $('meta[name="description"]').attr("content", "A changed site default")
      const [second] = await read($.html(), post)
      expect(second.summary).toBe(generic)
    } finally {
      release()
    }
    const [entry] = await first
    expect(entry.summary).toStartWith("Over the past several months")
  })
})
