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

const list = "/feeds/local-feed?filter=all"
const point: ReturnPoint = {
  list,
  href: `${list}&cursor=page-two`,
  id: "entry-100",
  ids: ["entry-99", "entry-100"],
}

describe("RSSF-12 list cursor tester edge cases", () => {
  test("malformed or stale storage cannot supply a partial return point", () => {
    for (const value of [
      "{",
      "undefined",
      "null",
      "false",
      "42",
      '"saved"',
      "[]",
      ...["list", "href", "id", "ids"].flatMap((field) =>
        [null, 1, false, {}].map((invalid) =>
          JSON.stringify({ ...point, [field]: invalid })
        )
      ),
      JSON.stringify({ ...point, ids: ["entry-100", null] }),
    ]) {
      expect(parseReturn(value)).toBeNull()
    }
  })

  test("repeated crossings use the current entry and do not mutate earlier return points", () => {
    const original = structuredClone(point)
    const third = followEntry(
      point,
      list,
      "entry-101",
      `${list}&cursor=at-101`
    )!
    const fourth = followEntry(
      third,
      list,
      "entry-102",
      `${list}&cursor=at-102`
    )!
    expect(backHref(fourth, list)).toBe(`${list}&cursor=at-102`)
    expect(restoreCursor(fourth, fourth.href, ["entry-102", "entry-103"])).toBe(
      0
    )
    const upward = followEntry(fourth, list, "entry-100", point.href)!
    expect(backHref(upward, list)).toBe(point.href)
    expect(restoreCursor(upward, point.href, ["entry-99", "entry-100"])).toBe(1)
    expect(point).toEqual(original)
    expect(third.id).toBe("entry-101")
    expect(fourth.id).toBe("entry-102")
  })

  test("feed and filter changes ignore a saved page even when entry ids coincide", () => {
    for (const other of [
      "/?filter=all",
      "/feeds/local-feed",
      "/feeds/other?filter=all",
    ]) {
      expect(backHref(point, other)).toBe(other)
      expect(followEntry(point, other, "entry-100", other)).toBeNull()
      expect(restoreCursor(point, other, ["entry-100"])).toBeNull()
    }
  })

  test("cursor follows identity after reordering, and clamps after the current final row disappears", () => {
    expect(restoreCursor(point, point.href, ["entry-100", "entry-99"])).toBe(0)
    expect(restoreCursor(point, point.href, ["entry-99"])).toBe(0)
    expect(restoreCursor(point, point.href, [])).toBe(0)
    expect(clampCursor(49, 49)).toBe(48)
    expect(moveCursor(0, -1, 0)).toBe(0)
    expect(moveCursor(0, 1, 0)).toBe(0)
    expect(moveCursor(0, 1, 1)).toBe(0)
    expect(moveCursor(0, -1, 1)).toBe(0)
  })
})
