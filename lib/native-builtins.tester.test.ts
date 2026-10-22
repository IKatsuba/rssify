import { readFileSync } from "node:fs"

import { beforeEach, describe, expect, test } from "bun:test"

import { builtinSource } from "@/sources/builtin"
import { db } from "@/test/db"

import { refreshFeed } from "./ingest/refresh"
import { SafeFetchError, type SafeFetch } from "./ingest/safe-fetch"
import { subscribe } from "./reader"

const NOW = new Date("2026-10-22T12:00:00Z")
const HOUR = 3_600_000
const fixture = (id: string) =>
  readFileSync(`test/fixtures/feeds/${id}.rss.xml`, "utf8")

beforeEach(async () => {
  await db.user.create({
    data: { id: "native-tester", name: "Tester", email: "native@example.com" },
  })
})

for (const id of ["nodejs-blog", "langchain-blog"]) {
  const source = builtinSource(id)!

  describe(`RSSF-24 ${id}`, () => {
    test("a direct feed add followed by the built-in reuses the subscription without fetching", async () => {
      let calls = 0
      const fetch: SafeFetch = async (url) => {
        expect(url).toBe(source.url)
        calls++
        return {
          url,
          status: 200,
          headers: new Headers(),
          kind: "xml",
          text: fixture(id),
        }
      }
      const first = await subscribe(
        "native-tester",
        { url: `${source.url}#ignored` },
        { fetch, now: NOW }
      )
      expect(first.ok).toBe(true)
      const second = await subscribe(
        "native-tester",
        { source: id },
        { fetch, now: NOW }
      )
      expect(second).toEqual({ ...first, existed: true })
      expect(calls).toBe(1)
      expect(await db.feed.count()).toBe(1)
      expect(await db.subscription.count()).toBe(1)
    })

    test("two full refreshes preserve entry identities, first text and read marks; 304 keeps them", async () => {
      const fetch: SafeFetch = async (url) => ({
        url,
        status: 200,
        headers: new Headers({ etag: '"native-v1"' }),
        kind: "xml",
        text: fixture(id),
      })
      const added = await subscribe(
        "native-tester",
        { source: id },
        { fetch, now: NOW }
      )
      if (!added.ok) throw new Error(`add failed: ${added.code}`)
      const entries = () =>
        db.entry.findMany({
          where: { feedId: added.feedId },
          orderBy: { id: "asc" },
        })
      const original = await entries()
      await db.readMark.create({
        data: { userId: "native-tester", entryId: original[0].id },
      })
      const changed: SafeFetch = async (url, options) => ({
        ...(await fetch(url, options)),
        text: fixture(id).replace(
          /<title>[^<]+<\/title>/g,
          "<title>Changed</title>"
        ),
      })
      for (const hour of [1, 2]) {
        expect(
          await refreshFeed(added.feedId, {
            fetch: changed,
            now: new Date(NOW.getTime() + hour * HOUR),
          })
        ).toMatchObject({ outcome: "ok" })
        expect(await entries()).toEqual(original)
      }
      const notModified: SafeFetch = async (url, options) => {
        expect(url).toBe(source.url)
        expect(options?.etag).toBe('"native-v1"')
        return {
          url,
          status: 304,
          headers: new Headers(),
          kind: "xml",
          text: "",
        }
      }
      await refreshFeed(added.feedId, {
        fetch: notModified,
        now: new Date(NOW.getTime() + 3 * HOUR),
      })
      expect(await entries()).toEqual(original)
      expect(await db.readMark.count()).toBe(1)
      expect(
        await db.feed.findUniqueOrThrow({ where: { id: added.feedId } })
      ).toMatchObject({ pluginId: null, failureCount: 0, status: "ok" })
    })

    for (const [status, code] of [
      [304, "unreachable"],
      [404, "not_found"],
      [429, "unreachable"],
      [500, "unreachable"],
    ] as const) {
      test(`initial HTTP ${status} writes nothing`, async () => {
        const fetch: SafeFetch = async (url) => {
          expect(url).toBe(source.url)
          return { url, status, text: "", kind: "xml", headers: new Headers() }
        }
        expect(
          await subscribe("native-tester", { source: id }, { fetch })
        ).toEqual({ ok: false, code })
        expect(await db.feed.count()).toBe(0)
        expect(await db.entry.count()).toBe(0)
        expect(await db.subscription.count()).toBe(0)
      })
    }

    for (const code of ["unreachable", "too_large"] as const) {
      test(`guarded fetch ${code} writes nothing`, async () => {
        const fetch: SafeFetch = async () => {
          throw new SafeFetchError(code)
        }
        expect(
          await subscribe("native-tester", { source: id }, { fetch })
        ).toEqual({ ok: false, code })
        expect(await db.feed.count()).toBe(0)
        expect(await db.subscription.count()).toBe(0)
      })
    }
  })
}
