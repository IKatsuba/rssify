import { describe, expect, test } from "bun:test"

import { longAgo, shortAgo } from "./relative-time"

const now = new Date(Date.UTC(2026, 9, 22, 12))
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000)
const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe("shortAgo", () => {
  test.each([
    [0, "now"],
    [59, "now"],
    [MINUTE, "1m"],
    [59 * MINUTE + 59, "59m"],
    [2 * HOUR, "2h"],
    [23 * HOUR, "23h"],
    [DAY, "1d"],
    [6 * DAY, "6d"],
    [7 * DAY, "1w"],
    [29 * DAY, "4w"],
    [30 * DAY, "1mo"],
    [364 * DAY, "12mo"],
    [365 * DAY, "1y"],
    [800 * DAY, "2y"],
  ])("%i seconds ago is %s", (seconds, text) => {
    expect(shortAgo(ago(seconds), now)).toBe(text)
  })

  test("a time in the future reads as now", () => {
    expect(shortAgo(ago(-HOUR), now)).toBe("now")
  })
})

describe("longAgo", () => {
  test.each([
    [0, "0 seconds ago"],
    [30, "30 seconds ago"],
    [MINUTE, "1 minute ago"],
    [3 * HOUR, "3 hours ago"],
    [DAY, "1 day ago"],
    [6 * DAY, "6 days ago"],
    [14 * DAY, "2 weeks ago"],
    [60 * DAY, "2 months ago"],
    [400 * DAY, "1 year ago"],
  ])("%i seconds ago is %s", (seconds, text) => {
    expect(longAgo(ago(seconds), now)).toBe(text)
  })

  test("a time in the future reads as 0 seconds ago", () => {
    expect(longAgo(ago(-DAY), now)).toBe("0 seconds ago")
  })
})
