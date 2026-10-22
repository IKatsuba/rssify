import { describe, expect, test } from "bun:test"

import {
  backHref,
  clampCursor,
  followEntry,
  moveCursor,
  parseReturn,
  restoreCursor,
  type ReturnPoint,
} from "./list-cursor"

const list = "/?filter=all"
const page2 = "/?filter=all&cursor=p2"
const point: ReturnPoint = { list, href: page2, id: "e2", ids: ["e1", "e2"] }

describe("moveCursor", () => {
  test("steps within the rows", () => {
    expect(moveCursor(0, 1, 3)).toBe(1)
    expect(moveCursor(2, 1, 3)).toBe(2)
    expect(moveCursor(0, -1, 3)).toBe(0)
  })
})

describe("clampCursor", () => {
  test("keeps the index when a row leaves and rests on the last row", () => {
    expect(clampCursor(2, 5)).toBe(2)
    expect(clampCursor(4, 4)).toBe(3)
    expect(clampCursor(3, 0)).toBe(0)
  })
})

describe("parseReturn", () => {
  test("reads a stored point and refuses anything else", () => {
    expect(parseReturn(JSON.stringify(point))).toEqual(point)
    expect(parseReturn(null)).toBeNull()
    expect(parseReturn("not json")).toBeNull()
    expect(parseReturn(JSON.stringify({ ...point, ids: [1] }))).toBeNull()
    expect(
      parseReturn(JSON.stringify({ list, href: page2, id: "e1" }))
    ).toBeNull()
  })
})

describe("restoreCursor", () => {
  test("puts the cursor on the entry's row on the page it is for", () => {
    expect(restoreCursor(point, page2, ["e1", "e2", "e3"])).toBe(1)
    expect(restoreCursor(point, page2, ["e0", "e1", "e2"])).toBe(2)
  })

  test("uses the first row when the entry has left the page", () => {
    expect(restoreCursor(point, page2, ["e1", "e3"])).toBe(0)
  })

  test("ignores a point for another page, such as page 1", () => {
    expect(restoreCursor(point, list, ["e1", "e2"])).toBeNull()
    expect(restoreCursor(null, page2, ["e1"])).toBeNull()
  })
})

describe("backHref", () => {
  test("returns to the saved page of this list", () => {
    expect(backHref(point, list)).toBe(page2)
  })

  test("uses the list's first page for another list or no point", () => {
    expect(backHref(point, "/feeds/f1")).toBe("/feeds/f1")
    expect(backHref(null, "/")).toBe("/")
  })
})

describe("followEntry", () => {
  test("j within the page keeps the page and moves the entry", () => {
    expect(followEntry(point, list, "e1", "/?filter=all&cursor=x")).toEqual({
      ...point,
      id: "e1",
    })
  })

  test("leaves the point for another list or the same entry", () => {
    expect(followEntry(point, "/", "e3", "/")).toBeNull()
    expect(followEntry(point, list, "e2", page2)).toBeNull()
  })

  test("page 2 → j into page 3 → Back lands on that entry's row", () => {
    // Opened the last row of page 2, then j stepped to e3, page 3's first.
    const page3From = "/?filter=all&cursor=above-e3"
    const followed = followEntry(point, list, "e3", page3From)
    expect(followed).toEqual({ list, href: page3From, id: "e3", ids: ["e3"] })
    const back = backHref(followed, list)
    expect(back).toBe(page3From)
    expect(restoreCursor(followed, back, ["e3", "e4", "e5"])).toBe(0)
    // One more j stays off the saved page: Back starts at e4.
    const again = followEntry(
      followed,
      list,
      "e4",
      "/?filter=all&cursor=above-e4"
    )
    expect(backHref(again, list)).toBe("/?filter=all&cursor=above-e4")
    expect(restoreCursor(again, backHref(again, list), ["e4", "e5"])).toBe(0)
  })

  test("k above the page's first row does the same upwards", () => {
    const page1From = "/?filter=all"
    const followed = followEntry(point, list, "e0", page1From)
    expect(backHref(followed, list)).toBe(page1From)
    expect(restoreCursor(followed, page1From, ["d9", "e0", "e1"])).toBe(1)
  })
})
