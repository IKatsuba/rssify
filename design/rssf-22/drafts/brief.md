# RSSF-22 brief: source plugins for the rsshub-only feeds

Lead's brief for the ingest, interface and state architects and the
critic. The owner's word for everything: as simple as possible, nothing
clever. `board show RSSF-22` is the task, whole; `design/rssf-1/DESIGN.md`
is the v1 design (§6 ingest, §7 plugins, §8 schema) and `AGENTS.md` the
current state of the code.

## Problem

The owner's katsuba.fm OPML
(`/Users/igorkatsuba/projects/ikatsuba/katsuba.fm/news512/sources/katsuba-fm.opml`)
reads nine feeds through a private rsshub. rssify cannot subscribe to
them:

| rsshub route | What it is |
| --- | --- |
| `github/discussion/angular/angular/Open/RFCs` | a repo's Discussions, filtered by state and category |
| `github/trending/monthly/javascript`, `…/typescript` | GitHub trending repos by period and language |
| `anthropic/news`, `anthropic/engineering` | anthropic.com/news, anthropic.com/engineering |
| `nodejs/blog/en` | nodejs.org/en/blog |
| `firefox/release/desktop` | Firefox desktop release notes |
| `bytes` | bytes.dev newsletter |
| `langchain/blog` | the LangChain blog |

Two public feeds also fail today: `https://hacks.mozilla.org/feed/` and
`https://tympanus.net/codrops/feed/` answer 403 (bot protection) to our
fetch.

## What a person sees and does

- Pastes a URL into Add a feed, the same field as today. A GitHub URL a
  person copies from the browser (a repo's discussions, a category, a
  filtered list; a trending page with language and period) becomes a
  subscription, configured by that URL. No new form, no new settings page,
  unless an architect shows it is needed.
- Picks one of the named sites from the built-in source list, or pastes its
  URL, and gets entries.
- Reads entries as today; a failing source shows the usual failing marker
  and last error.

## What exists (do not re-derive)

- `SourcePlugin { id, matches: string, fetchEntries({ fetch, known,
  deadline }) }`; `pluginFor(url)` matches `matches === url` exactly.
  `Feed.pluginId` stores the id; `Feed.url` is the plugin's list page.
- `fetchForAdd` runs a matching plugin with one 40 s deadline; zero
  entries or a non-fetch throw is `not_found`. `refreshFeed` runs it with
  the same deadline, `known()` over stored guids, the usual store,
  retention and backoff; `SourceStatusError` carries a list page's status.
- `builtinSources` (id, title, url, note) feeds the add dialog and
  `{ source }` in actions, `/api/v1` and MCP.
- `safeFetch` is the only outbound path: public addresses only, 10 MB,
  UA `rssify/1.0 (+https://github.com/IKatsuba/rssify)`, a feed-preferring
  `Accept`. No headless browser.
- Every 15 minutes the cron claims due feeds; each feed is polled hourly
  on success, with exponential backoff on failure.

## Constraints

- The stack as built: Next.js on Vercel (Pro, Fluid compute, consumer
  `maxDuration = 60`), Neon through Prisma, Vercel Cron + Queues,
  safe-fetch for every outbound request. No new service, no headless
  browser, no rsshub.
- A real RSS/Atom URL beats a plugin. A plugin is for a source without a
  usable feed. Measure what each site serves today, locally, and record it.
- An env variable (e.g. `GITHUB_TOKEN`) or a paid service is the owner's
  decision: write it as a question with options and a default; the lead
  takes it to main.
- A token never leaves the server, is never logged, never stored in the
  database, and is sent only to the GitHub API host.
- Nothing touches Vercel, Neon, production or a real queue. No code is
  written; tests in the design are a plan.

## Non-goals

- A general rsshub replacement or a user-defined scraper.
- Per-user GitHub tokens or GitHub sign-in.
- New UI beyond what adding by URL and the built-in list need.
- Releases, tags and commits already have GitHub's own Atom feeds
  (`/releases.atom` etc., in the OPML today); they need no plugin.

## Open questions

### Ingest (`drafts/ingest.md`)

1. For each named site: does it serve a real feed today (check
   `<link rel=alternate>`, common paths, sitemaps)? Measure with our UA
   and record status, content type and a sample. A feed found means a
   built-in source pointing at it, no plugin.
2. For each site without a feed: is the list and post data in the static
   HTML (or a JSON the page loads)? Which selectors, which date, guid,
   content? What does breakage look like?
3. GitHub: which URL shapes does the family accept (discussions of a repo,
   by category, by `is:open/closed/answered` query; trending by language,
   `since`, spoken language; anything else that falls out naturally, e.g.
   issues/PRs by label, is your call to justify or leave out)? REST vs
   GraphQL per shape; trending has no API, so is its HTML scrapable?
   Rate limits with and without a token, cost per refresh of each shape,
   the headers to honour (`x-ratelimit-*`, `retry-after`), and what
   happens with no token configured.
4. How does a plugin send the token only to `api.github.com` through
   safe-fetch (headers? a POST for GraphQL? safe-fetch takes GET today)?
5. The 403s on hacks.mozilla.org and tympanus.net: measure with today's
   UA, a browser-like UA and other headers. Is it the UA, the Accept,
   TLS fingerprint, IP reputation (Vercel's IPs vs local)? Recommend
   changing headers globally, per host, or calling them out of reach.
   Do not impersonate a browser without saying so plainly.

### Interface (`drafts/interface.md`)

1. How a person adds each kind: paste URL, built-in list entries (which of
   the new sources to list, titles and notes), what the feed is titled in
   the sidebar (e.g. "angular/angular · RFCs discussions").
2. The sentences: an unsupported GitHub URL, no token configured, rate
   limited, a repo without discussions, a private or missing repo.
3. How a trending entry and a discussion entry read in the list and the
   entry page (what goes in title, summary, content).
4. Whether anything changes in Settings, Admin or the MCP/API
   `{ source }` surface.

### State (`drafts/state.md`)

1. How a parameterised plugin is stored: is the canonical URL in
   `Feed.url` enough (config parsed from it each refresh), or is a config
   column needed? Canonicalisation so two URL spellings share one feed.
2. The plugin interface change: `matches` becomes a function/parser?
   What `pluginFor` and `refreshFeed` change; what a removed or renamed
   shape does to stored feeds.
3. Guids and dedup: a trending repo returns month after month; a
   discussion is edited and gains comments. What is one entry, what is
   its guid, and does "first version wins" still hold?
4. Polling cadence and the GitHub budget: is hourly per feed fine for N
   feeds, or does a GitHub feed need its own interval or shared rate-limit
   state? Prefer no new state.
5. The test plan: fixtures, seams for the token and the GitHub API, and
   what the ship team tests per unit.

## Output

Each architect writes only its draft, commits it signed, and reports to
the lead. The lead merges `design/rssf-22/DESIGN.md` with build units
small enough for one ship run each.
