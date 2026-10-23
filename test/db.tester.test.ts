import { describe, expect, test } from "bun:test"

import { assertTestDatabaseUrl, db } from "./db"

describe("database guard edge cases", () => {
  test.each([
    "",
    "not a URL",
    "postgresql://localhost/rssify_test?host=127.0.0.2",
    "postgresql://localhost/rssify_test?host=localhost,db.example.invalid",
    "postgresql://localhost/rssify_test_backup",
    "postgresql://localhost/rssify_test/extra",
    "postgresql://[::1]/rssify_test",
  ])("refuses unsafe or ambiguous database URL %s", (url) => {
    expect(() => assertTestDatabaseUrl(url)).toThrow()
  })

  test("accepts the driver's postgres alias and encoded test database", () => {
    expect(() =>
      assertTestDatabaseUrl("postgres://rssify@127.0.0.1:54329/rssify%5Ftest")
    ).not.toThrow()
  })
})

async function seedReader() {
  const user = await db.user.create({
    data: { id: "tester-owner", name: "Owner", email: "owner@example.invalid" },
  })
  const feed = await db.feed.create({
    data: { url: "https://example.invalid/feed" },
  })
  const entry = await db.entry.create({
    data: { feedId: feed.id, guid: "one", title: "One", sortAt: new Date() },
  })
  await db.subscription.create({ data: { userId: user.id, feedId: feed.id } })
  await db.readMark.create({ data: { userId: user.id, entryId: entry.id } })
  return { user, feed, entry }
}

describe("migrated reader relations", () => {
  test("a repeated guid is unique within its feed, but allowed in another", async () => {
    const { feed, entry } = await seedReader()
    await expect(
      Promise.resolve(
        db.entry.create({
          data: {
            feedId: feed.id,
            guid: entry.guid,
            title: "Repeat",
            sortAt: new Date(),
          },
        })
      )
    ).rejects.toMatchObject({ code: "P2002" })
    const other = await db.feed.create({
      data: { url: "https://example.invalid/other" },
    })
    await db.entry.create({
      data: {
        feedId: other.id,
        guid: entry.guid,
        title: "Other",
        sortAt: new Date(),
      },
    })
    expect(await db.entry.count()).toBe(2)
  })

  test("subscriptions and read marks cannot duplicate", async () => {
    const { user, feed, entry } = await seedReader()
    await expect(
      Promise.resolve(
        db.subscription.create({ data: { userId: user.id, feedId: feed.id } })
      )
    ).rejects.toMatchObject({ code: "P2002" })
    await expect(
      Promise.resolve(
        db.readMark.create({ data: { userId: user.id, entryId: entry.id } })
      )
    ).rejects.toMatchObject({ code: "P2002" })
  })

  test("deleting a feed cascades entries, subscriptions and read marks", async () => {
    const { feed } = await seedReader()
    await db.feed.delete({ where: { id: feed.id } })
    expect(await db.entry.count()).toBe(0)
    expect(await db.subscription.count()).toBe(0)
    expect(await db.readMark.count()).toBe(0)
    expect(await db.user.count()).toBe(1)
  })

  test("deleting a user cascades auth and reader rows while preserving shared content", async () => {
    const { user } = await seedReader()
    await db.session.create({
      data: {
        id: "tester-session",
        token: "test-session-placeholder",
        userId: user.id,
        expiresAt: new Date(Date.now() + 60000),
      },
    })
    await db.account.create({
      data: {
        id: "tester-account",
        accountId: "tester-vercel",
        providerId: "vercel",
        userId: user.id,
      },
    })
    await db.apikey.create({
      data: {
        id: "tester-key-row",
        referenceId: user.id,
        key: "stored-test-hash-placeholder",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })
    await db.user.delete({ where: { id: user.id } })
    expect(await db.session.count()).toBe(0)
    expect(await db.account.count()).toBe(0)
    expect(await db.apikey.count()).toBe(0)
    expect(await db.subscription.count()).toBe(0)
    expect(await db.readMark.count()).toBe(0)
    expect(await db.feed.count()).toBe(1)
    expect(await db.entry.count()).toBe(1)
  })

  test("a read mark cannot refer to an absent entry", async () => {
    const { user } = await seedReader()
    await expect(
      Promise.resolve(
        db.readMark.create({
          data: { userId: user.id, entryId: "missing-entry" },
        })
      )
    ).rejects.toMatchObject({ code: "P2003" })
  })
})
