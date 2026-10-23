import { readFileSync } from "node:fs"

import { expect, test } from "bun:test"

import { db } from "@/test/db"

import { refreshFeed } from "./ingest/refresh"
import type { SafeFetch } from "./ingest/safe-fetch"
import { subscribe } from "./reader"

const LIST = "https://bytes.dev/archives"
const POST = `${LIST}/531`
const pages: Record<string, string> = {
  [LIST]: readFileSync("test/fixtures/bytes/archives.html", "utf8"),
  [POST]: readFileSync("test/fixtures/bytes/531.html", "utf8"),
}
const fetch: SafeFetch = async (url) => ({
  url,
  status: pages[url] ? 200 : 404,
  text: pages[url] ?? "",
  headers: new Headers(),
  kind: "unknown",
})

test("Bytes built-in and alternate spelling share one feed without refetching or duplicating entries", async () => {
  await db.user.createMany({
    data: ["bytes-tester-1", "bytes-tester-2"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
    })),
  })
  expect(
    await subscribe("bytes-tester-1", { source: "bytes" }, { fetch })
  ).toMatchObject({ ok: true, existed: false })
  const feed = await db.feed.findUniqueOrThrow({ where: { url: LIST } })
  expect(feed).toMatchObject({
    title: "Bytes",
    siteUrl: LIST,
    pluginId: "bytes",
  })
  const noFetch: SafeFetch = async (url) => {
    throw new Error(`Unexpected fetch: ${url}`)
  }
  expect(
    await subscribe(
      "bytes-tester-2",
      { url: "https://www.bytes.dev/archives/" },
      { fetch: noFetch }
    )
  ).toMatchObject({ ok: true, existed: false, feedId: feed.id })
  expect(
    await subscribe("bytes-tester-2", { source: "bytes" }, { fetch: noFetch })
  ).toMatchObject({ ok: true, existed: true, feedId: feed.id })
  expect(await db.feed.count()).toBe(1)
  expect(await db.subscription.count({ where: { feedId: feed.id } })).toBe(2)
  expect(await db.entry.count({ where: { feedId: feed.id } })).toBe(1)
  for (let i = 0; i < 2; i++) {
    expect(await refreshFeed(feed.id, { fetch })).toEqual({
      outcome: "failed",
      error: "none of the new posts could be read",
    })
  }
  expect(await db.entry.count({ where: { feedId: feed.id } })).toBe(1)
  expect(
    await db.feed.findUniqueOrThrow({ where: { id: feed.id } })
  ).toMatchObject({
    title: "Bytes",
    failureCount: 2,
    lastError: "none of the new posts could be read",
  })
})
