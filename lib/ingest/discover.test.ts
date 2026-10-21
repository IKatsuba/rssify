import { describe, expect, test } from "bun:test"

import { discoverFeeds } from "./discover"

const PAGE = "https://example.com/blog/index.html"
const page = (head: string) =>
  `<!doctype html><html><head>${head}</head><body></body></html>`

describe("discoverFeeds", () => {
  test("finds each feed type, resolved against the page, in order", () => {
    const html = page(`
      <link rel="alternate" type="application/rss+xml" href="/rss.xml">
      <link rel="alternate" type="application/atom+xml" href="atom.xml">
      <link rel="alternate" type="application/rdf+xml" href="https://other.example/rdf">
      <link rel="alternate" type="application/feed+json" href="feed.json">
      <link rel="alternate" type="application/json" href="/feed/json">`)
    expect(discoverFeeds(html, PAGE)).toEqual([
      "https://example.com/rss.xml",
      "https://example.com/blog/atom.xml",
      "https://other.example/rdf",
      "https://example.com/blog/feed.json",
      "https://example.com/feed/json",
    ])
  })

  test("matches rel tokens and type case-insensitively, with parameters", () => {
    const html = page(`
      <link rel="Alternate  home" type="Application/RSS+XML; charset=utf-8" href="/a">
      <link rel="alternative" type="application/rss+xml" href="/b">
      <link rel="stylesheet alternate" type="text/css" href="/c.css">
      <link rel="alternate" href="/d">
      <link rel="alternate" hreflang="fr" type="text/html" href="/fr">`)
    expect(discoverFeeds(html, PAGE)).toEqual(["https://example.com/a"])
  })

  test("resolves against <base href>, itself relative to the page", () => {
    const html = page(`
      <base href="/feeds/">
      <link rel="alternate" type="application/atom+xml" href="main.atom">`)
    expect(discoverFeeds(html, PAGE)).toEqual([
      "https://example.com/feeds/main.atom",
    ])
    const absolute = page(`
      <base href="https://cdn.example.net/x/">
      <link rel="alternate" type="application/atom+xml" href="main.atom">`)
    expect(discoverFeeds(absolute, PAGE)).toEqual([
      "https://cdn.example.net/x/main.atom",
    ])
  })

  test("drops non-http(s) and unparseable hrefs", () => {
    const html = page(`
      <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
      <link rel="alternate" type="application/rss+xml" href="ftp://example.com/f">
      <link rel="alternate" type="application/rss+xml" href="http://[::1">
      <link rel="alternate" type="application/rss+xml" href="">
      <link rel="alternate" type="application/rss+xml" href="http://example.com/ok">`)
    expect(discoverFeeds(html, PAGE)).toEqual(["http://example.com/ok"])
  })

  test("dedupes after resolving, keeping first position", () => {
    const html = page(`
      <link rel="alternate" type="application/rss+xml" href="/rss.xml">
      <link rel="alternate" type="application/atom+xml" href="/atom.xml">
      <link rel="alternate" type="application/rss+xml" href="https://example.com/rss.xml">`)
    expect(discoverFeeds(html, PAGE)).toEqual([
      "https://example.com/rss.xml",
      "https://example.com/atom.xml",
    ])
  })

  test("finds links outside <head> and guesses nothing", () => {
    expect(discoverFeeds("<p>No feeds here</p>", PAGE)).toEqual([])
    expect(discoverFeeds("", PAGE)).toEqual([])
    expect(
      discoverFeeds(
        '<body><link rel="alternate" type="application/rss+xml" href="/late"></body>',
        PAGE
      )
    ).toEqual(["https://example.com/late"])
  })
})
