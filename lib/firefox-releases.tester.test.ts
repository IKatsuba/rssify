import { readFileSync } from "node:fs"

import { expect, test } from "bun:test"

import { db } from "@/test/db"

import { refreshFeed } from "./ingest/refresh"
import type { SafeFetch } from "./ingest/safe-fetch"
import { subscribe } from "./reader"

const LIST = "https://www.firefox.com/en-US/releases/"
const savedList = readFileSync(
  "test/fixtures/firefox-releases/releases.html",
  "utf8"
)
const savedPost = readFileSync(
  "test/fixtures/firefox-releases/158.0.html",
  "utf8"
)
const calls: string[] = []
const fetch: SafeFetch = async (url) => {
  calls.push(url)
  return {
    url,
    status: 200,
    text: url === LIST ? savedList : savedPost,
    headers: new Headers(),
    kind: "unknown",
  }
}

async function addUser(id: string) {
  await db.user.create({ data: { id, name: id, email: `${id}@example.com` } })
}

test("Firefox built-in and Mozilla spellings share one feed; bounded backfill and repeated refresh never duplicate", async () => {
  calls.length = 0
  await addUser("firefox-tester-1")
  await addUser("firefox-tester-2")
  expect(
    await subscribe(
      "firefox-tester-1",
      { source: "firefox-releases" },
      { fetch }
    )
  ).toMatchObject({ ok: true, existed: false })
  const feed = await db.feed.findUniqueOrThrow({ where: { url: LIST } })
  expect(feed).toMatchObject({
    title: "Firefox release notes",
    siteUrl: LIST,
    pluginId: "firefox-releases",
  })
  expect(await db.entry.count({ where: { feedId: feed.id } })).toBe(10)
  const noFetch: SafeFetch = async (url) => {
    throw new Error(`Unexpected fetch ${url}`)
  }
  expect(
    await subscribe(
      "firefox-tester-2",
      { url: "https://mozilla.org/en-US/firefox/releases" },
      { fetch: noFetch }
    )
  ).toMatchObject({ ok: true, existed: false, feedId: feed.id })
  expect(
    await subscribe(
      "firefox-tester-2",
      { source: "firefox-releases" },
      { fetch: noFetch }
    )
  ).toMatchObject({ ok: true, existed: true, feedId: feed.id })
  expect(await db.feed.count()).toBe(1)
  expect(await db.subscription.count({ where: { feedId: feed.id } })).toBe(2)
  for (const stored of [10, 10, 0, 0]) {
    expect(await refreshFeed(feed.id, { fetch })).toEqual({
      outcome: "ok",
      stored,
    })
  }
  const entries = await db.entry.findMany({ where: { feedId: feed.id } })
  expect(entries).toHaveLength(30)
  expect(new Set(entries.map((entry) => entry.guid)).size).toBe(30)
  expect(entries.every((entry) => !entry.guid.includes("esr"))).toBe(true)
  expect(
    await db.feed.findUniqueOrThrow({ where: { id: feed.id } })
  ).toMatchObject({
    title: "Firefox release notes",
    failureCount: 0,
    lastError: null,
  })
  expect(calls).toHaveLength(35)
})

test.each([403, 429])(
  "Firefox list HTTP %i keeps entries and applies the documented Retry-After rule",
  async (status) => {
    await addUser(`firefox-status-${status}`)
    await subscribe(
      `firefox-status-${status}`,
      { source: "firefox-releases" },
      { fetch }
    )
    const feed = await db.feed.findUniqueOrThrow({ where: { url: LIST } })
    const now = new Date("2026-10-22T12:00:00Z")
    const failure: SafeFetch = async (url) => ({
      url,
      status,
      text: "",
      headers: new Headers({ "Retry-After": "43200" }),
      kind: "unknown",
    })
    expect(await refreshFeed(feed.id, { fetch: failure, now })).toMatchObject({
      outcome: "failed",
    })
    expect(
      await db.feed.findUniqueOrThrow({ where: { id: feed.id } })
    ).toMatchObject({
      failureCount: 1,
      nextFetchAt: new Date(
        now.getTime() + (status === 403 ? 2 : 12) * 3600000
      ),
    })
    expect(await db.entry.count({ where: { feedId: feed.id } })).toBe(10)
  }
)
