import { describe, expect, test } from "bun:test"

import {
  createApiKeyInput,
  entryInput,
  listEntriesInput,
  markAllReadInput,
  revokeApiKeyInput,
  subscribeInput,
  unsubscribeInput,
} from "./reader-schemas"

describe("subscribeInput", () => {
  test("takes a url or a source", () => {
    expect(subscribeInput.parse({ url: "https://example.com" })).toEqual({
      url: "https://example.com",
    })
    expect(subscribeInput.parse({ source: "cursor-blog" })).toEqual({
      source: "cursor-blog",
    })
  })

  test("refuses both, neither, extra keys and non-strings", () => {
    for (const input of [
      { url: "https://example.com", source: "cursor-blog" },
      {},
      { url: "https://example.com", other: 1 },
      { url: 7 },
      { source: null },
      null,
      "https://example.com",
    ]) {
      expect(subscribeInput.safeParse(input).success).toBe(false)
    }
  })
})

test("ids are nonempty strings", () => {
  expect(unsubscribeInput.parse({ feedId: "f1" })).toEqual({ feedId: "f1" })
  expect(entryInput.parse({ entryId: "e1" })).toEqual({ entryId: "e1" })
  expect(revokeApiKeyInput.parse({ keyId: "k1" })).toEqual({ keyId: "k1" })
  for (const value of ["", 7, undefined, null]) {
    expect(unsubscribeInput.safeParse({ feedId: value }).success).toBe(false)
    expect(entryInput.safeParse({ entryId: value }).success).toBe(false)
    expect(revokeApiKeyInput.safeParse({ keyId: value }).success).toBe(false)
  }
})

describe("listEntriesInput", () => {
  test("defaults to all entries, 50 at a time", () => {
    expect(listEntriesInput.parse({})).toEqual({ unreadOnly: false, limit: 50 })
  })

  test("takes a scope, a limit up to 100 and a cursor", () => {
    expect(
      listEntriesInput.parse({
        feedId: "f1",
        unreadOnly: true,
        limit: 100,
        cursor: "c",
      })
    ).toEqual({ feedId: "f1", unreadOnly: true, limit: 100, cursor: "c" })
  })

  test("refuses limits outside 1–100 and non-integers", () => {
    for (const limit of [0, 101, 1.5, "50"]) {
      expect(listEntriesInput.safeParse({ limit }).success).toBe(false)
    }
    expect(listEntriesInput.safeParse({ unreadOnly: "true" }).success).toBe(
      false
    )
  })
})

describe("markAllReadInput", () => {
  test("takes a Date or an ISO timestamp and gives a Date", () => {
    const upTo = new Date("2026-10-22T10:00:00.000Z")
    expect(markAllReadInput.parse({ upTo })).toEqual({ upTo })
    expect(
      markAllReadInput.parse({ feedId: "f1", upTo: upTo.toISOString() })
    ).toEqual({ feedId: "f1", upTo })
    expect(
      markAllReadInput.parse({ upTo: "2026-10-22T12:00:00+02:00" })
    ).toEqual({ upTo })
  })

  test("refuses a missing, invalid or non-ISO cutoff", () => {
    for (const upTo of [
      undefined,
      null,
      0,
      "bad-date",
      "2026-10-22",
      new Date("nope"),
    ]) {
      expect(markAllReadInput.safeParse({ upTo }).success).toBe(false)
    }
  })
})

describe("createApiKeyInput", () => {
  test("takes a trimmed name of 1–64 characters", () => {
    expect(createApiKeyInput.parse({ name: "  NetNewsWire " })).toEqual({
      name: "NetNewsWire",
    })
    expect(createApiKeyInput.parse({ name: "x".repeat(64) }).name).toHaveLength(
      64
    )
  })

  test("refuses empty, blank, too long and non-string names", () => {
    for (const name of ["", "   ", "x".repeat(65), 7, undefined]) {
      expect(createApiKeyInput.safeParse({ name }).success).toBe(false)
    }
  })
})
