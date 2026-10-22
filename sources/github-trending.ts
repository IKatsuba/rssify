import { load } from "cheerio"

import {
  escapeHtml,
  normaliseEntry,
  type IngestedEntry,
} from "@/lib/ingest/parse"

import { LAYOUT_CHANGED } from "./list-posts"
import { SourceStatusError, type SourcePlugin } from "./types"

const ORIGIN = "https://github.com"
const PERIODS: Record<string, string> = {
  daily: "today",
  weekly: "this week",
  monthly: "this month",
}

const ok = (status: number) => status >= 200 && status < 300
const squash = (value: string) => value.replace(/\s+/g, " ").trim()

// One stored URL per trending list. GitHub shows any other `since` as daily
// without saying so, so such a URL is not ours rather than a silent daily.
function canonical(url: URL): string | null {
  if (url.host !== "github.com" && url.host !== "www.github.com") return null
  const match = url.pathname.match(/^\/trending(?:\/([^/]+))?\/?$/)
  if (!match) return null
  let lang = ""
  if (match[1]) {
    try {
      lang = decodeURIComponent(match[1]).toLowerCase()
    } catch {
      return null
    }
    if (lang === "developers") return null
  }
  const since = url.searchParams.get("since") ?? "daily"
  if (!(since in PERIODS)) return null
  const code = url.searchParams.get("spoken_language_code")
  // encodeURIComponent writes a slug as GitHub links it: c++ is c%2B%2B.
  return (
    `${ORIGIN}/trending${lang ? `/${encodeURIComponent(lang)}` : ""}` +
    `?since=${since}` +
    (code ? `&spoken_language_code=${encodeURIComponent(code)}` : "")
  )
}

// GitHub's slugs as they are, so trending feeds sort together by name.
function title(url: string): string {
  const parsed = new URL(url)
  const slug = parsed.pathname.split("/")[2]
  return [
    "GitHub trending",
    slug && decodeURIComponent(slug),
    PERIODS[parsed.searchParams.get("since") ?? "daily"],
    parsed.searchParams.get("spoken_language_code"),
  ]
    .filter(Boolean)
    .join(" · ")
}

// Rows are read through Primer classes and itemprop, not build hashes.
async function fetchEntries(
  ctx: Parameters<SourcePlugin["fetchEntries"]>[0]
): Promise<IngestedEntry[]> {
  const response = await ctx.fetch(ctx.url, { deadline: ctx.deadline })
  if (!ok(response.status)) {
    throw new SourceStatusError(response.status, response.headers)
  }
  const $ = load(response.text)
  const rows = $("article.Box-row")
  // An empty list is real only when GitHub says so.
  if (rows.length === 0 && $(".blankslate").length) return []

  const entries: IngestedEntry[] = []
  rows.each((_, row) => {
    const text = (selector: string) =>
      squash($(row).find(selector).first().text())
    const href = $(row).find("h2 a[href]").attr("href")
    const repo = href?.match(/^\/([^/?#]+\/[^/?#]+)$/)?.[1]
    if (!repo) return
    const url = `${ORIGIN}/${repo}`
    const description = text("p")
    const stars = text('a[href$="/stargazers"]')
    const forks = text('a[href$="/forks"]')
    const stats = [
      text('[itemprop="programmingLanguage"]'),
      stars && `${stars} stars`,
      forks && `${forks} forks`,
      text("span.d-inline-block.float-sm-right"),
    ].filter(Boolean)
    const content =
      (description ? `<p>${escapeHtml(description)}</p>` : "") +
      `<p>${escapeHtml(stats.join(" · "))}</p>`
    entries.push(
      normaliseEntry(
        {
          // Lowercased, so a repo is shown once ever, whatever its casing.
          id: url.toLowerCase(),
          url,
          title: escapeHtml(repo),
          summary: description ? escapeHtml(description) : null,
          content,
        },
        url
      )
    )
  })
  if (entries.length === 0) throw new Error(LAYOUT_CHANGED)
  return entries
}

export const githubTrending: SourcePlugin = {
  id: "github-trending",
  canonical,
  title,
  fetchEntries,
}
