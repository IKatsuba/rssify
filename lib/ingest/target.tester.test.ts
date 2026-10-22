import { describe, expect, test } from "bun:test"

import { pluginFor } from "@/sources/index"
import type { SourcePlugin } from "@/sources/types"

import { canonicalUrl } from "./target"

const PAGE = "https://example.com/list"
const inert: SourcePlugin = {
  id: "inert",
  canonical: () => null,
  fetchEntries: async () => {
    throw new Error("lookup must not perform I/O")
  },
}

describe("target contract tester boundaries", () => {
  test("one plugin cannot mutate the URL inspected by the next", () => {
    const mutator: SourcePlugin = {
      ...inert,
      canonical: (url) => {
        url.pathname = "/different"
        url.search = "?changed=true"
        return null
      },
    }
    const owner: SourcePlugin = {
      ...inert,
      id: "owner",
      canonical: (url) => (url.href === PAGE ? PAGE : null),
    }
    expect(pluginFor(PAGE, { mutator, owner })).toEqual({
      plugin: owner,
      url: PAGE,
    })
  })

  test("invalid and non-HTTP inputs never reach a plugin", () => {
    let calls = 0
    const owner: SourcePlugin = {
      ...inert,
      canonical: () => {
        calls++
        return PAGE
      },
    }
    for (const input of [
      "",
      "https://[",
      "/list",
      "mailto:a@example.com",
      "file:///list",
      "data:text/html,list",
    ]) {
      expect(canonicalUrl(input, { owner })).toBeNull()
    }
    expect(calls).toBe(0)
  })

  test("normalisation removes fragments before plugin lookup and preserves an unowned query", () => {
    const seen: string[] = []
    const observer: SourcePlugin = {
      ...inert,
      canonical: (url) => {
        seen.push(url.href)
        return null
      },
    }
    const input = "  HTTPS://EXAMPLE.COM:443/a/../list?tag=a&tag=b#post  "
    expect(canonicalUrl(input, { observer })).toBe(`${PAGE}?tag=a&tag=b`)
    expect(seen).toEqual([`${PAGE}?tag=a&tag=b`])
  })
})
