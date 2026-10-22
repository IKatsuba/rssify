import { expect, test } from "bun:test"

import { db } from "@/test/db"

import { getEntry, getNeighbours, listSubscriptions } from "./reader"
import { entryHref, readEntryParams } from "./reader-view"

test("shared-entry reads and scoped navigation preserve each user's existing read state", async () => {
  for (const id of ["entry-reader", "entry-other"]) {
    await db.user.create({
      data: { id, name: id, email: `${id}@example.invalid` },
    })
  }
  const feed = await db.feed.create({
    data: {
      url: "https://entry.example.invalid/feed",
      subscriptions: {
        create: [{ userId: "entry-reader" }, { userId: "entry-other" }],
      },
      entries: {
        create: [0, 1, 2].map((i) => ({
          id: `view-entry-${i}`,
          guid: String(i),
          title: `Entry ${i}`,
          sortAt: new Date(`2026-10-0${i + 1}T00:00:00Z`),
        })),
      },
    },
  })
  await db.readMark.create({
    data: { userId: "entry-other", entryId: "view-entry-1" },
  })
  const before = await db.readMark.findMany()
  for (const filter of ["unread", "all"] as const) {
    const href = entryHref("view-entry-1", { feedId: feed.id, filter })
    const query = Object.fromEntries(
      new URL(href, "http://localhost").searchParams
    )
    const params = readEntryParams(query)
    expect(params).toEqual({ feedId: feed.id, filter })
    expect(await getEntry("entry-reader", "view-entry-1")).toMatchObject({
      read: false,
    })
    expect(
      await getNeighbours("entry-reader", "view-entry-1", {
        feedId: params.feedId,
        unreadOnly: params.filter === "unread",
      })
    ).toEqual({ previousId: "view-entry-2", nextId: "view-entry-0" })
  }
  expect(await getEntry("entry-other", "view-entry-1")).toMatchObject({
    read: true,
  })
  expect((await listSubscriptions("entry-reader"))[0].unreadCount).toBe(3)
  expect((await listSubscriptions("entry-other"))[0].unreadCount).toBe(2)
  expect(await db.readMark.findMany()).toEqual(before)
})

test("ambiguous entry list context falls back without accepting repeated feed or filter values", () => {
  expect(
    readEntryParams({ feed: ["owned", "foreign"], filter: ["all", "unread"] })
  ).toEqual({ feedId: undefined, filter: "unread" })
  expect(readEntryParams({ feed: "", filter: "ALL" })).toEqual({
    feedId: undefined,
    filter: "unread",
  })
})
