import { expect, test } from "bun:test"

import { db } from "@/test/db"

import { subscriptionsOf, totalUnread } from "./data"

test("sidebar counts and titles are scoped to each session user, including shared feeds", async () => {
  for (const id of ["sidebar-owner", "sidebar-other", "sidebar-empty"]) {
    await db.user.create({
      data: { id, name: id, email: `${id}@example.invalid` },
    })
  }
  const shared = await db.feed.create({
    data: {
      title: "Z shared",
      url: "https://shared.example.invalid/feed",
      subscriptions: {
        create: [{ userId: "sidebar-owner" }, { userId: "sidebar-other" }],
      },
      entries: {
        create: [
          { guid: "one", title: "One", sortAt: new Date() },
          { guid: "two", title: "Two", sortAt: new Date() },
        ],
      },
    },
    include: { entries: true },
  })
  await db.readMark.create({
    data: { userId: "sidebar-owner", entryId: shared.entries[0].id },
  })
  await db.feed.create({
    data: {
      title: "Private title",
      url: "https://private.example.invalid/feed",
      subscriptions: { create: { userId: "sidebar-other" } },
      entries: {
        create: { guid: "secret", title: "Private", sortAt: new Date() },
      },
    },
  })
  await db.feed.create({
    data: {
      title: null,
      url: "https://fallback.example.invalid/feed",
      status: "gone",
      subscriptions: { create: { userId: "sidebar-owner" } },
    },
  })
  const owner = await subscriptionsOf("sidebar-owner")
  expect(owner.map(({ feed }) => feed.title ?? feed.url)).toEqual([
    "https://fallback.example.invalid/feed",
    "Z shared",
  ])
  expect(owner.map(({ unreadCount }) => unreadCount)).toEqual([0, 1])
  expect(await totalUnread("sidebar-owner")).toBe(1)
  expect(await totalUnread("sidebar-other")).toBe(3)
  expect(await totalUnread("sidebar-empty")).toBe(0)
  expect(await subscriptionsOf("sidebar-empty")).toEqual([])
  expect(await db.readMark.count()).toBe(1)
})
