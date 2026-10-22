import { expect, test } from "bun:test"

import { db } from "@/test/db"

import { deleteUser, listFeeds, listUsers } from "./admin"

test("admin lists are empty without users or subscribed feeds", async () => {
  await db.feed.create({ data: { url: "https://orphan.example/feed" } })
  expect(await listUsers()).toEqual([])
  expect(await listFeeds()).toEqual([])
})

test("users with the same join time have stable id order", async () => {
  const createdAt = new Date("2026-01-01T00:00:00Z")
  await db.user.createMany({
    data: ["z", "a"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
      createdAt,
    })),
  })
  expect((await listUsers()).map(({ id, feeds }) => [id, feeds])).toEqual([
    ["a", 0],
    ["z", 0],
  ])
})

test("repeated deletion preserves shared content and unrelated orphans", async () => {
  await db.user.createMany({
    data: ["removed", "kept"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
    })),
  })
  const shared = await db.feed.create({
    data: {
      url: "https://shared.example/feed",
      subscriptions: { create: [{ userId: "removed" }, { userId: "kept" }] },
      entries: {
        create: {
          guid: "unchanged",
          title: "Stored title",
          contentHtml: "<p>Stored content</p>",
          sortAt: new Date("2026-01-01T00:00:00Z"),
          readMarks: { create: [{ userId: "removed" }, { userId: "kept" }] },
        },
      },
    },
    include: { entries: { include: { readMarks: true } } },
  })
  const orphan = await db.feed.create({
    data: { url: "https://unrelated.example/feed" },
  })
  await deleteUser("admin", "removed")
  await deleteUser("admin", "removed")
  expect(
    await db.entry.findUnique({ where: { id: shared.entries[0].id } })
  ).toEqual(
    expect.objectContaining({
      title: "Stored title",
      contentHtml: "<p>Stored content</p>",
      guid: "unchanged",
    })
  )
  expect(await db.readMark.findMany({ select: { userId: true } })).toEqual([
    { userId: "kept" },
  ])
  expect(await db.feed.count({ where: { id: orphan.id } })).toBe(1)
  expect(
    (await listFeeds()).map(({ id, subscribers }) => [id, subscribers])
  ).toEqual([[shared.id, 1]])
})
