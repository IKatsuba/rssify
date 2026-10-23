import { beforeEach, describe, expect, test } from "bun:test"

import type { SourcePlugin } from "@/sources/types"
import { db } from "@/test/db"

import * as api from "./api-v1"
import { auth } from "./auth"
import { normaliseEntry } from "./ingest/parse"
import type { SafeFetch } from "./ingest/safe-fetch"
import { subscribe } from "./reader"

const PAGE = "https://site.example/news"
const LIST = "https://lists.example/list"
const ALIAS = "http://www.lists.example/list/"
const post = normaliseEntry({ id: "post", title: "First version" }, LIST)
const owner = (fetchEntries: SourcePlugin["fetchEntries"]): SourcePlugin => ({
  id: "lists",
  canonical: (url) =>
    url.hostname.replace(/^www\./, "") === "lists.example" &&
    url.pathname.replace(/\/$/, "") === "/list"
      ? LIST
      : null,
  fetchEntries,
})
const noFetch: SafeFetch = async () => {
  throw new Error("unexpected fetch")
}
const html = (...urls: string[]) =>
  urls
    .map(
      (url) => `<link rel="alternate" type="application/rss+xml" href="${url}">`
    )
    .join("")
const answer = (url: string, text: string) => ({
  url,
  text,
  status: 200,
  headers: new Headers(),
  kind: "unknown" as const,
})

beforeEach(async () => {
  await db.user.create({
    data: {
      id: "canonical-tester",
      name: "Tester",
      email: "canonical@example.invalid",
    },
  })
})

describe("canonical subscribe tester acceptance", () => {
  test("same-user concurrent aliases keep one subscription and the winning entry version", async () => {
    let arrived = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const urls: string[] = []
    const plugins = {
      lists: owner(async (ctx) => {
        urls.push(ctx.url)
        const title = `Version ${++arrived}`
        if (arrived === 2) release()
        await gate
        return [{ ...post, title }]
      }),
    }
    const results = await Promise.all([
      subscribe(
        "canonical-tester",
        { url: ALIAS },
        { plugins, fetch: noFetch }
      ),
      subscribe(
        "canonical-tester",
        { url: `${LIST}#top` },
        { plugins, fetch: noFetch }
      ),
    ])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.map((r) => r.ok && r.existed).sort()).toEqual([false, true])
    expect(urls).toEqual([LIST, LIST])
    expect(await db.feed.count()).toBe(1)
    expect(await db.subscription.count()).toBe(1)
    const entry = await db.entry.findFirstOrThrow()
    expect(["Version 1", "Version 2"]).toContain(entry.title)
    expect(await db.entry.count()).toBe(1)
    const again = await subscribe(
      "canonical-tester",
      { url: ALIAS },
      {
        plugins: {
          lists: owner(async () => {
            throw new Error("known alias must not fetch")
          }),
        },
        fetch: noFetch,
      }
    )
    expect(again).toMatchObject({ ok: true, existed: true })
    expect(await db.entry.findFirstOrThrow()).toEqual(entry)
  })

  test("multiple discovered aliases collapse to one fresh feed without a choice dialog", async () => {
    const calls: string[] = []
    const plugins = {
      lists: owner(async (ctx) => {
        calls.push(ctx.url)
        return [post]
      }),
    }
    const fetch: SafeFetch = async (url) => {
      expect(url).toBe(PAGE)
      return answer(url, html(ALIAS, `${LIST}#one`, `${LIST}/`))
    }
    expect(
      await subscribe("canonical-tester", { url: PAGE }, { plugins, fetch })
    ).toMatchObject({ ok: true, existed: false })
    expect(calls).toEqual([LIST])
    expect((await db.feed.findFirstOrThrow()).url).toBe(LIST)
    expect(await db.feed.count()).toBe(1)
  })

  test("canonical discovery rechecks a plain row created during the page request", async () => {
    const plugins = {
      lists: owner(async () => {
        throw new Error("stored row must not run plugin")
      }),
    }
    const fetch: SafeFetch = async (url) => {
      expect(url).toBe(PAGE)
      await db.feed.create({
        data: {
          id: "late-feed",
          url: LIST,
          pluginId: null,
          title: "Plain original",
          status: "gone",
          nextFetchAt: null,
        },
      })
      return answer(url, html(ALIAS, `${LIST}#other`))
    }
    expect(
      await subscribe("canonical-tester", { url: PAGE }, { plugins, fetch })
    ).toEqual({ ok: true, existed: false, feedId: "late-feed" })
    expect(
      await db.feed.findUniqueOrThrow({ where: { id: "late-feed" } })
    ).toMatchObject({
      pluginId: null,
      title: "Plain original",
      status: "gone",
      nextFetchAt: null,
    })
    expect(await db.entry.count()).toBe(0)
  })

  test("a failed canonical discovered plugin leaves no rows and another spelling can retry", async () => {
    let empty = true
    const plugins = { lists: owner(async () => (empty ? [] : [post])) }
    const fetch: SafeFetch = async (url) => {
      expect(url).toBe(PAGE)
      return answer(url, html(ALIAS, LIST))
    }
    expect(
      await subscribe("canonical-tester", { url: PAGE }, { plugins, fetch })
    ).toEqual({ ok: false, code: "not_found" })
    expect(await db.feed.count()).toBe(0)
    expect(await db.subscription.count()).toBe(0)
    expect(await db.entry.count()).toBe(0)
    empty = false
    expect(
      await subscribe(
        "canonical-tester",
        { url: `${LIST}/` },
        { plugins, fetch: noFetch }
      )
    ).toMatchObject({ ok: true, existed: false })
    expect((await db.feed.findFirstOrThrow()).url).toBe(LIST)
  })

  test("the API reports 201 then 200 for two spellings, and discovery exposes canonical choices in 422", async () => {
    const key = (
      await auth.api.createApiKey({ body: { userId: "canonical-tester" } })
    ).key
    const request = (url: string) =>
      new Request("http://localhost:3210/api/v1/subscriptions", {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ url }),
      })
    let calls = 0
    const plugins = {
      lists: owner(async () => {
        calls++
        return [post]
      }),
    }
    const first = await api.subscribe(request(ALIAS), {
      plugins,
      fetch: noFetch,
    })
    const second = await api.subscribe(request(`${LIST}#again`), {
      plugins,
      fetch: noFetch,
    })
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual(await first.json())
    expect(calls).toBe(1)
    const choices = await api.subscribe(request(PAGE), {
      plugins,
      fetch: async (url) =>
        answer(url, html(ALIAS, LIST, "https://other.example/feed")),
    })
    expect(choices.status).toBe(422)
    expect(await choices.json()).toMatchObject({
      error: {
        code: "multiple",
        choices: [LIST, "https://other.example/feed"],
      },
    })
  })
})
