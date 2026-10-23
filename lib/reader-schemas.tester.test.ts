import { describe, expect, test } from "bun:test"

import {
  createApiKeyInput,
  getEntryInput,
  listEntriesInput,
  markAllReadInput,
  markReadInput,
  markUnreadInput,
  subscribeInput,
} from "./reader-schemas"

describe("shared reader inputs: transport edge cases", () => {
  test("subscribe leaves URL/source failures to the reader instead of coercing them", () => {
    for (const url of ["", "not a URL", "https://example.com/rss#part"]) {
      expect(subscribeInput.parse({ url })).toEqual({ url })
    }
    expect(subscribeInput.parse({ source: "" })).toEqual({ source: "" })
    expect(
      subscribeInput.safeParse({
        url: "https://example.com",
        source: undefined,
      }).success
    ).toBe(false)
  })

  test("list refuses empty scopes/cursors and non-finite limits without coercion", () => {
    for (const input of [
      { feedId: "" },
      { cursor: "" },
      { feedId: null },
      { cursor: 12 },
      { limit: NaN },
      { limit: Infinity },
      { limit: null },
      { unreadOnly: 1 },
    ]) {
      expect(listEntriesInput.safeParse(input).success).toBe(false)
    }
    expect(listEntriesInput.parse({ limit: 1, unreadOnly: false })).toEqual({
      limit: 1,
      unreadOnly: false,
    })
  })

  test("get/read/unread share the same entry-id acceptance rules", () => {
    for (const schema of [getEntryInput, markReadInput, markUnreadInput]) {
      expect(schema.parse({ entryId: "entry-1" })).toEqual({
        entryId: "entry-1",
      })
      for (const entryId of ["", null, false, [], {}]) {
        expect(schema.safeParse({ entryId }).success).toBe(false)
      }
    }
  })

  test("cutoff rejects impossible dates and timezone-free timestamps", () => {
    for (const upTo of [
      "2026-02-30T00:00:00Z",
      "2026-10-22T00:00:00",
      "2026-10-22T25:00:00Z",
      "2026-10-22T00:00:00+25:00",
      "1761091200000",
    ]) {
      expect(markAllReadInput.safeParse({ upTo }).success).toBe(false)
    }
    expect(
      markAllReadInput.parse({ upTo: "2026-10-22T00:30:00-03:30" }).upTo
    ).toEqual(new Date("2026-10-22T04:00:00Z"))
    expect(
      markAllReadInput.safeParse({ feedId: "", upTo: new Date() }).success
    ).toBe(false)
  })

  test("key names apply length bounds after trimming surrounding whitespace", () => {
    expect(
      createApiKeyInput.parse({ name: `\t${"x".repeat(64)}\n` }).name
    ).toBe("x".repeat(64))
    for (const name of ["\t\r\n", null, true, ["reader"]]) {
      expect(createApiKeyInput.safeParse({ name }).success).toBe(false)
    }
  })
})
