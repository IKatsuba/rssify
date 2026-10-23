import { describe, expect, test } from "bun:test"

import {
  emptyState,
  entryCount,
  entryHref,
  feedNotice,
  listHref,
  readEntryParams,
  readListParams,
  siteName,
} from "./reader-view"

describe("readListParams", () => {
  test("Unread is the default; only filter=all turns it off", () => {
    expect(readListParams({})).toEqual({
      filter: "unread",
      cursor: undefined,
      before: undefined,
    })
    expect(readListParams({ filter: "all" }).filter).toBe("all")
    expect(readListParams({ filter: "ALL" }).filter).toBe("unread")
    expect(readListParams({ filter: ["all", "all"] }).filter).toBe("unread")
  })

  test("cursor and before pass through; empty or repeated ones do not", () => {
    expect(readListParams({ cursor: "c", before: "b" })).toMatchObject({
      cursor: "c",
      before: "b",
    })
    expect(readListParams({ cursor: "", before: ["a", "b"] })).toMatchObject({
      cursor: undefined,
      before: undefined,
    })
  })
})

describe("listHref", () => {
  test("leaves defaults out of the URL", () => {
    expect(listHref("/", { filter: "unread" })).toBe("/")
    expect(listHref("/feeds/f1", { filter: "all" })).toBe(
      "/feeds/f1?filter=all"
    )
    expect(listHref("/", { filter: "all", cursor: "a+b/c=" })).toBe(
      "/?filter=all&cursor=a%2Bb%2Fc%3D"
    )
    expect(listHref("/", { filter: "unread", before: "x" })).toBe("/?before=x")
  })
})

describe("entryHref", () => {
  test("carries the list it came from", () => {
    expect(entryHref("e1", { filter: "unread" })).toBe("/entries/e1")
    expect(entryHref("e1", { feedId: "f1", filter: "all" })).toBe(
      "/entries/e1?feed=f1&filter=all"
    )
  })
})

describe("readEntryParams", () => {
  test("the list an entry came from", () => {
    expect(readEntryParams({})).toEqual({ feedId: undefined, filter: "unread" })
    expect(readEntryParams({ feed: "f1", filter: "all" })).toEqual({
      feedId: "f1",
      filter: "all",
    })
    expect(readEntryParams({ feed: ["f1", "f2"] }).feedId).toBeUndefined()
  })
})

describe("siteName", () => {
  test("the host, without www.", () => {
    expect(siteName("https://www.example.com/a?b")).toBe("example.com")
    expect(siteName("http://blog.example.org:8080/")).toBe("blog.example.org")
  })
})

describe("emptyState", () => {
  const base = { rows: 0, paged: false, subscriptions: 3 } as const

  test("rows, or a page past the first, show no empty state", () => {
    expect(emptyState({ ...base, rows: 1, filter: "unread" })).toBeNull()
    expect(emptyState({ ...base, paged: true, filter: "unread" })).toBeNull()
  })

  test("All feeds", () => {
    expect(emptyState({ ...base, subscriptions: 0, filter: "unread" })).toBe(
      "no_feeds"
    )
    expect(emptyState({ ...base, subscriptions: 0, filter: "all" })).toBe(
      "no_feeds"
    )
    expect(emptyState({ ...base, filter: "unread" })).toBe("caught_up")
    expect(emptyState({ ...base, filter: "all" })).toBe("nothing_at_all")
  })

  test("one feed", () => {
    const feed = { ...base, feedId: "f1" }
    expect(
      emptyState({ ...feed, filter: "unread", feedHasEntries: true })
    ).toBe("feed_no_unread")
    expect(
      emptyState({ ...feed, filter: "unread", feedHasEntries: false })
    ).toBe("feed_no_entries")
    expect(emptyState({ ...feed, filter: "all" })).toBe("feed_no_entries")
  })
})

describe("feedNotice", () => {
  const now = new Date(Date.UTC(2026, 9, 22, 12))
  const sixDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)

  test("an ok feed has none", () => {
    expect(
      feedNotice({ status: "ok", lastError: null, lastSuccessAt: now }, now)
    ).toBeNull()
  })

  test("failing, with the last success and the error as stored", () => {
    expect(
      feedNotice(
        {
          status: "failing",
          lastError: "the site answered 404 Not Found",
          lastSuccessAt: sixDaysAgo,
        },
        now
      )
    ).toEqual({
      title: "This feed isn’t updating",
      description:
        "Last updated 6 days ago. The last try failed: the site answered 404 Not Found. We’ll keep trying.",
    })
  })

  test("failing and never fetched", () => {
    expect(
      feedNotice(
        {
          status: "failing",
          lastError: "the address couldn’t be found",
          lastSuccessAt: null,
        },
        now
      )?.description
    ).toBe(
      "We haven’t been able to fetch it yet. The last try failed: the address couldn’t be found. We’ll keep trying."
    )
  })

  test("failing without a stored error leaves that sentence out", () => {
    expect(
      feedNotice(
        { status: "failing", lastError: null, lastSuccessAt: sixDaysAgo },
        now
      )?.description
    ).toBe("Last updated 6 days ago. We’ll keep trying.")
  })

  test("gone", () => {
    expect(
      feedNotice(
        {
          status: "gone",
          lastError: "the site answered 410 Gone",
          lastSuccessAt: sixDaysAgo,
        },
        now
      )
    ).toEqual({
      title: "This feed has stopped",
      description:
        "The site says this feed is gone, so we no longer check it. Its entries stay until you unsubscribe.",
    })
  })
})

describe("entryCount", () => {
  test("singular for one, plural otherwise", () => {
    expect(entryCount(0)).toBe("0 entries")
    expect(entryCount(1)).toBe("1 entry")
    expect(entryCount(37)).toBe("37 entries")
  })
})
