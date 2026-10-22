import { expect, test } from "bun:test"

import { db } from "@/test/db"

import { listEntries } from "./reader"

test("50-row pages round-trip through tied dates under All and Unread without crossing ownership", async () => {
  for (const id of ["paging-owner", "paging-other"]) {
    await db.user.create({
      data: { id, name: id, email: `${id}@example.invalid` },
    })
  }
  const sortAt = new Date("2026-10-01T12:00:00Z")
  const own = await db.feed.create({
    data: {
      url: "https://paging.example.invalid/feed",
      subscriptions: { create: { userId: "paging-owner" } },
    },
  })
  const other = await db.feed.create({
    data: {
      url: "https://other.example.invalid/feed",
      subscriptions: { create: { userId: "paging-other" } },
    },
  })
  await db.entry.createMany({
    data: Array.from({ length: 157 }, (_, i) => ({
      id: `paging-${String(i).padStart(3, "0")}`,
      feedId: own.id,
      guid: String(i),
      title: `Entry ${i}`,
      sortAt,
    })),
  })
  await db.entry.createMany({
    data: ["private-1", "private-2"].map((id) => ({
      id,
      feedId: other.id,
      guid: id,
      title: "Other user",
      sortAt,
    })),
  })
  await db.readMark.createMany({
    data: Array.from({ length: 157 }, (_, i) => i)
      .filter((i) => i % 4 === 0)
      .map((i) => ({
        userId: "paging-owner",
        entryId: `paging-${String(i).padStart(3, "0")}`,
      })),
  })

  for (const unreadOnly of [false, true]) {
    const scope = { feedId: own.id, unreadOnly }
    const first = await listEntries("paging-owner", scope)
    const second = await listEntries("paging-owner", {
      ...scope,
      cursor: first.nextCursor!,
    })
    const third = await listEntries("paging-owner", {
      ...scope,
      cursor: second.nextCursor!,
    })
    expect(first.entries).toHaveLength(50)
    expect(second.entries).toHaveLength(50)
    expect(third.entries.length).toBeGreaterThan(0)
    const backSecond = await listEntries("paging-owner", {
      ...scope,
      before: third.prevCursor!,
    })
    const backFirst = await listEntries("paging-owner", {
      ...scope,
      before: backSecond.prevCursor!,
    })
    expect(backSecond.entries).toEqual(second.entries)
    expect(backFirst.entries).toEqual(first.entries)
    expect(backFirst.prevCursor).toBeNull()
    let page = first
    const ids: string[] = []
    for (;;) {
      ids.push(...page.entries.map((e) => e.id))
      if (!page.nextCursor) break
      page = await listEntries("paging-owner", {
        ...scope,
        cursor: page.nextCursor,
      })
    }
    const expected = Array.from({ length: 157 }, (_, i) => i)
      .filter((i) => !unreadOnly || i % 4 !== 0)
      .map((i) => `paging-${String(i).padStart(3, "0")}`)
      .reverse()
    expect(ids).toEqual(expected)
    expect(new Set(ids).size).toBe(ids.length)
  }
  const foreignPage = await listEntries("paging-other", { limit: 1 })
  for (const direction of ["cursor", "before"] as const) {
    const page = await listEntries("paging-owner", {
      [direction]: foreignPage.nextCursor!,
    })
    expect(page.entries.every((e) => e.feedId === own.id)).toBe(true)
    await expect(
      listEntries("paging-owner", {
        feedId: other.id,
        [direction]: foreignPage.nextCursor!,
      })
    ).rejects.toMatchObject({ code: "not_found" })
  }
  expect(await db.readMark.count()).toBe(40)
})
