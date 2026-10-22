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

const older = "/?filter=all&cursor=abc"
const point: ReturnPoint = {
  list: "/?filter=all",
  href: older,
  id: "e2",
  index: 1,
}

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
    expect(parseReturn(JSON.stringify({ ...point, index: -1 }))).toBeNull()
    expect(parseReturn(JSON.stringify({ list: "/", id: "e1" }))).toBeNull()
  })
})

describe("restoreCursor", () => {
  test("puts the cursor on the entry's row on the page it came from", () => {
    expect(restoreCursor(point, older, ["e1", "e2", "e3"])).toBe(1)
    expect(restoreCursor(point, older, ["e0", "e1", "e2"])).toBe(2)
  })

  test("falls back to the index when the row left an Unread list", () => {
    expect(restoreCursor(point, older, ["e1", "e3"])).toBe(1)
    expect(restoreCursor({ ...point, index: 7 }, older, ["e1", "e3"])).toBe(1)
  })

  test("ignores a point for another page, such as page 1", () => {
    expect(restoreCursor(point, "/?filter=all", ["e1", "e2"])).toBeNull()
    expect(restoreCursor(null, older, ["e1"])).toBeNull()
  })
})

describe("backHref", () => {
  test("returns to the paged list the entry was opened from", () => {
    expect(backHref(point, "/?filter=all")).toBe(older)
  })

  test("uses the list's first page for another list or no point", () => {
    expect(backHref(point, "/feeds/f1?filter=all")).toBe("/feeds/f1?filter=all")
    expect(backHref(null, "/")).toBe("/")
  })
})

describe("followEntry", () => {
  test("moves the point to the entry shown in the same list", () => {
    expect(followEntry(point, "/?filter=all", "e3")).toEqual({
      ...point,
      id: "e3",
    })
  })

  test("leaves the point for another list or the same entry", () => {
    expect(followEntry(point, "/", "e3")).toBeNull()
    expect(followEntry(point, "/?filter=all", "e2")).toBeNull()
  })
})
