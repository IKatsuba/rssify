import { load, type CheerioAPI } from "cheerio"

import { normaliseEntry, type IngestedEntry } from "@/lib/ingest/parse"

import { fetchListThenPosts, type Post } from "./list-posts"
import type { SourcePlugin } from "./types"

const ORIGIN = "https://www.firefox.com"
const LIST_URL = `${ORIGIN}/en-US/releases/`
// mozilla.org's old address of the list redirects to firefox.com.
const SPELLINGS = new Set([
  LIST_URL,
  `${ORIGIN}/en-US/releases`,
  ...["https://www.mozilla.org", "https://mozilla.org"].flatMap((o) => [
    `${o}/en-US/firefox/releases`,
    `${o}/en-US/firefox/releases/`,
  ]),
])
// Majors and their dot releases; ESR ("153.0esr", "153.1.0") is left out.
const NOTES = /^\/firefox\/(\d+\.0(?:\.\d+)?)\/releasenotes\/$/
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

// The page shows a calendar day ("October 13, 2026"), read as UTC
// midnight. Parsed by hand because Date's own parsing is lenient.
export function releaseDate(text: string): string | null {
  const match = text.trim().match(/^([A-Z][a-z]+) (\d{1,2}), (\d{4})$/)
  const month = match ? MONTHS.indexOf(match[1]) : -1
  if (month < 0) return null
  const day = Number(match![2])
  const date = new Date(Date.UTC(Number(match![3]), month, day))
  return date.getUTCMonth() === month && date.getUTCDate() === day
    ? date.toISOString()
    : null
}

// Release links in document order, de-duplicated (the list repeats some).
function links($: CheerioAPI, pageUrl: string): Post[] {
  const posts = new Map<string, Post>()
  $("a[href]").each((_, link) => {
    let url
    try {
      url = new URL($(link).attr("href")!, pageUrl)
    } catch {
      return
    }
    if (url.origin !== ORIGIN || !NOTES.test(url.pathname)) return
    url.hash = ""
    url.search = ""
    if (!posts.has(url.href)) {
      posts.set(url.href, { url: url.href, listDate: null })
    }
  })
  return [...posts.values()]
}

// The page has no description of its own, so a missing body leaves an
// entry with the title and date only.
function readPost(html: string, post: Post): IngestedEntry | null {
  const $ = load(html)
  const date = $(".c-release-date").first()
  const body = $(".c-release-notes").first()
  if (!date.length && !body.length) return null
  const version = NOTES.exec(new URL(post.url).pathname)![1]
  // The summary starts at the first note: a section heading ("New",
  // "Fixed") in front of it reads as noise, or "Fixed Fixed …".
  const notes = body.clone()
  notes.find("h1, h2, h3, h4, h5, h6").remove()
  return normaliseEntry(
    {
      id: post.url,
      url: post.url,
      title: `Firefox ${version}`,
      published: releaseDate(date.text()),
      summary: body.length ? notes.html() : null,
      content: body.length ? body.html() : null,
    },
    post.url
  )
}

export const firefoxReleases: SourcePlugin = {
  id: "firefox-releases",
  // href is already normalised, so a query, hash, port or credentials
  // make it no spelling of ours.
  canonical: (url) => (SPELLINGS.has(url.href) ? LIST_URL : null),
  fetchEntries: (ctx) =>
    fetchListThenPosts(ctx, { listUrl: LIST_URL, links, readPost }),
}
