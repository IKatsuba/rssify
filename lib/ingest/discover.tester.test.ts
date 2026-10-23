import { describe, expect, test } from "bun:test"

import { discoverFeeds } from "./discover"

const PAGE = "https://example.com/news/index.html"

describe("discoverFeeds tester edge cases", () => {
  test("handles HTML attribute casing, rel whitespace and escaped query strings", () => {
    expect(
      discoverFeeds(
        `<LINK REL="home\tAlTeRnAtE\n" TYPE=" Application/Feed+JSON ; charset=UTF-8" HREF="../feed?x=1&amp;y=2">`,
        PAGE
      )
    ).toEqual(["https://example.com/feed?x=1&y=2"])
  })

  test("uses the first base and deduplicates equivalent absolute URLs", () => {
    expect(
      discoverFeeds(
        `<base href="//feeds.example.com/root/">
         <base href="https://ignored.example.com/">
         <link rel="alternate" type="application/rss+xml" href="../rss">
         <link rel="alternate" type="application/atom+xml" href="https://FEEDS.example.com:443/rss">
         <link rel="alternate" type="application/feed+json" href="./next">`,
        PAGE
      )
    ).toEqual([
      "https://feeds.example.com/rss",
      "https://feeds.example.com/root/next",
    ])
  })

  test("an unsafe first base falls back to the page without using later bases", () => {
    expect(
      discoverFeeds(
        `<base href="javascript:alert(1)"><base href="https://ignored.example/">
         <link rel="alternate" type="application/rss+xml" href="feed.xml">
         <link rel="alternate" type="application/rss+xml" href="  JaVaScRiPt:alert(1)  ">
         <link rel="alternate" type="application/rss+xml" href="data:text/xml,feed">`,
        PAGE
      )
    ).toEqual(["https://example.com/news/feed.xml"])
  })

  test("does not discover textual markup, anchors or unannounced paths", () => {
    expect(
      discoverFeeds(
        `<!-- <link rel="alternate" type="application/rss+xml" href="/comment"> -->
         <script>const example = '<link rel="alternate" type="application/rss+xml" href="/script">'</script>
         <a rel="alternate" type="application/rss+xml" href="/anchor">RSS</a>
         <link rel="notalternate" type="application/rss+xml" href="/wrong-token">
         <link rel="alternate" type="application/rss+xml-invalid" href="/wrong-type">
         <p>Try /feed or /rss.xml</p>`,
        PAGE
      )
    ).toEqual([])
  })

  test("recovers a declared link in truncated HTML after a large body", () => {
    const html = `${"<p>ordinary page text</p>".repeat(50_000)}<link rel=alternate type=application/rss+xml href=/feed><div`
    expect(discoverFeeds(html, PAGE)).toEqual(["https://example.com/feed"])
  })
})
