import { readFileSync } from "node:fs"

import { beforeEach, describe, expect, test } from "bun:test"

import type { SafeFetch } from "@/lib/ingest/safe-fetch"
import { db } from "@/test/db"

import { subscribe } from "./reader"

beforeEach(async () => {
  for (const id of ["anthropic-tester-1", "anthropic-tester-2"]) {
    await db.user.create({ data: { id, name: id, email: `${id}@example.com` } })
  }
})

describe("Anthropic built-in subscription tester regressions", () => {
  for (const section of ["engineering", "news"]) {
    const source = `anthropic-${section}`
    const url = `https://www.anthropic.com/${section}`
    const list = readFileSync(`test/fixtures/${source}/list.html`, "utf8")
    const fetch: SafeFetch = async (target) => ({
      url: target,
      status: 200,
      headers: new Headers(),
      text:
        target === url
          ? list
          : '<meta property="og:title" content="Post"><meta name="description" content="Summary">',
      kind: "unknown",
    })

    test(`${source}: URL spelling and built-in share a feed without refetching or duplicates`, async () => {
      const first = await subscribe("anthropic-tester-1", { source }, { fetch })
      expect(first).toMatchObject({ ok: true, existed: false })
      const noFetch: SafeFetch = async () => {
        throw new Error("Existing canonical feed must not fetch")
      }
      const second = await subscribe(
        "anthropic-tester-2",
        { url: `https://anthropic.com/${section}/#top` },
        { fetch: noFetch }
      )
      const repeated = await subscribe(
        "anthropic-tester-1",
        { source },
        { fetch: noFetch }
      )
      expect(second).toMatchObject({ ok: true, existed: false })
      expect(repeated).toMatchObject({ ok: true, existed: true })
      expect(await db.feed.count()).toBe(1)
      expect(await db.subscription.count()).toBe(2)
      expect(await db.entry.count()).toBe(10)
      const feed = await db.feed.findUniqueOrThrow({ where: { url } })
      expect(feed).toMatchObject({
        pluginId: source,
        title: `Anthropic ${section}`,
        siteUrl: url,
      })
    })

    test(`${source}: unreadable posts do not leave a feed or subscription`, async () => {
      const failed: SafeFetch = async (target, options) =>
        target === url
          ? fetch(target, options)
          : {
              url: target,
              status: 404,
              headers: new Headers(),
              text: "",
              kind: "unknown",
            }
      expect(
        await subscribe("anthropic-tester-1", { source }, { fetch: failed })
      ).toMatchObject({ ok: false, code: "not_found" })
      expect(await db.feed.count()).toBe(0)
      expect(await db.subscription.count()).toBe(0)
      expect(await db.entry.count()).toBe(0)
    })
  }
})
