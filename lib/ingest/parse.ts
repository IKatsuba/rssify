import { createHash } from "node:crypto"

import { parseFeed as parseXmlFeed } from "@rowanmanning/feed-parser"

import { plainText, safeUrl, sanitizeContent } from "./sanitize"

const SUMMARY_MAX = 300
const TITLE_FALLBACK_MAX = 80
const UNTITLED = "(untitled)"

export interface IngestedEntry {
  guid: string
  url: string | null
  title: string
  author: string | null
  publishedAt: Date | null
  summary: string | null
  contentHtml: string | null
}

export interface ParsedFeed {
  title: string | null
  siteUrl: string | null
  entries: IngestedEntry[]
}

// One entry as a format (or a source plugin) reads it, before
// normalising. Text fields are HTML; a format whose field is plain text
// escapes it first, so `plainText` gives the same text back.
export interface RawEntry {
  id?: string | null
  url?: string | null
  title?: string | null
  author?: string | null
  published?: Date | string | null
  updated?: Date | string | null
  summary?: string | null
  content?: string | null
}

export type FeedParseErrorCode = "not_a_feed" | "invalid_feed"

export class FeedParseError extends Error {
  constructor(
    readonly code: FeedParseErrorCode,
    message: string
  ) {
    super(message)
    this.name = "FeedParseError"
  }
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function normaliseEntry(raw: RawEntry, base: string): IngestedEntry {
  const url = safeUrl(raw.url, base)
  // An Atom entry with only <updated> is dated by it; a missing date
  // stays null rather than becoming "now".
  const publishedAt = toDate(raw.published) ?? toDate(raw.updated)
  const summary =
    plainText(raw.summary || raw.content || "", SUMMARY_MAX) || null
  const title =
    plainText(raw.title ?? "", Infinity) ||
    (summary &&
      Array.from(summary).slice(0, TITLE_FALLBACK_MAX).join("").trim()) ||
    UNTITLED
  const guid =
    text(raw.id) ??
    url ??
    createHash("sha1")
      .update(title + (publishedAt?.toISOString() ?? ""))
      .digest("hex")
  return {
    guid,
    url,
    title,
    author: text(raw.author),
    publishedAt,
    summary,
    contentHtml: sanitizeContent(raw.content || raw.summary || "", url ?? base),
  }
}

type XmlFeed = ReturnType<typeof parseXmlFeed>
type XmlElement = XmlFeed["element"]

// Atom text constructs are plain text unless typed html/xhtml (RFC 4287
// §3.1), and the parser hands them back decoded; escape them so
// normaliseEntry, which reads HTML, keeps "<tag>" as text. RSS fields are
// HTML in practice and pass as they are.
function atomHtml(
  atom: boolean,
  parent: XmlElement,
  name: string,
  value: string | null
): string | null {
  const element = parent.findElementWithName(name)
  if (!atom || value === null || !element) return value
  const type = element.getAttribute("type")?.trim().toLowerCase()
  return !type || type === "text" || type === "text/plain"
    ? escapeHtml(value)
    : value
}

function parseXml(body: string, feedUrl: string): ParsedFeed {
  let feed: XmlFeed
  try {
    feed = parseXmlFeed(body)
  } catch (error) {
    // The parser raises INVALID_FEED only when no rss/rdf/feed root is
    // present (an HTML page, say); anything else is a broken document.
    if ((error as { code?: string }).code === "INVALID_FEED")
      throw new FeedParseError("not_a_feed", "The body is not a feed")
    throw new FeedParseError("invalid_feed", "The feed could not be parsed")
  }
  const atom = feed.meta.type === "atom"
  return {
    title:
      plainText(
        atomHtml(atom, feed.element, "title", feed.title) ?? "",
        Infinity
      ) || null,
    siteUrl: safeUrl(feed.url, feedUrl),
    entries: feed.items.map((item) =>
      normaliseEntry(
        {
          id: item.id,
          url: item.url,
          title: atomHtml(atom, item.element, "title", item.title),
          author: item.authors[0]?.name,
          published: item.published,
          updated: item.updated,
          summary: atomHtml(atom, item.element, "summary", item.description),
          content: atomHtml(atom, item.element, "content", item.content),
        },
        feedUrl
      )
    ),
  }
}

type JsonAuthor = { name?: unknown }
type JsonItem = Record<string, unknown>

const str = (value: unknown) => (typeof value === "string" ? value : null)
const escaped = (value: unknown) => {
  const s = str(value)
  return s === null ? null : escapeHtml(s)
}

function parseJson(body: string, feedUrl: string): ParsedFeed {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(body)
  } catch {
    throw new FeedParseError("invalid_feed", "The feed is not valid JSON")
  }
  if (
    typeof json !== "object" ||
    json === null ||
    !str(json.version)?.startsWith("https://jsonfeed.org/version/") ||
    !Array.isArray(json.items)
  )
    throw new FeedParseError("invalid_feed", "The JSON is not a JSON Feed")

  const items = json.items.filter(
    (item): item is JsonItem => typeof item === "object" && item !== null
  )
  return {
    title: plainText(escaped(json.title) ?? "", Infinity) || null,
    siteUrl: safeUrl(str(json.home_page_url), feedUrl),
    entries: items.map((item) => {
      const authors = Array.isArray(item.authors)
        ? (item.authors as JsonAuthor[])
        : []
      const contentText = str(item.content_text)
      return normaliseEntry(
        {
          id: typeof item.id === "number" ? String(item.id) : str(item.id),
          url: str(item.url),
          title: escaped(item.title),
          author:
            str(authors[0]?.name) ?? str((item.author as JsonAuthor)?.name),
          published: str(item.date_published),
          updated: str(item.date_modified),
          summary: escaped(item.summary),
          content:
            str(item.content_html) ??
            (contentText === null ? null : `<p>${escapeHtml(contentText)}</p>`),
        },
        feedUrl
      )
    }),
  }
}

export function parseFeed(body: string, feedUrl: string): ParsedFeed {
  const trimmed = body.replace(/^﻿/, "").trim()
  if (trimmed === "")
    throw new FeedParseError("invalid_feed", "The body is empty")
  if (trimmed.startsWith("{")) return parseJson(trimmed, feedUrl)
  if (trimmed.startsWith("<")) return parseXml(trimmed, feedUrl)
  throw new FeedParseError("not_a_feed", "The body is not a feed")
}
