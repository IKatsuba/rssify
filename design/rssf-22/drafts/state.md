# RSSF-22 state draft: parameterised plugins in data and over time

State architect's answers to the brief's State questions. Summary: **no
schema change, no migration, no new env beyond the owner's `GITHUB_TOKEN`
question, no shared rate-limit state.** A parameterised plugin stores its
canonical URL in `Feed.url` and parses its config back from it on every
refresh. Written before `drafts/ingest.md` landed; where a choice depends on
ingest's measurements (which GitHub shapes, REST vs GraphQL, how a header
reaches safe-fetch) this draft names the requirement, not the mechanism.

## 1. Storage: the canonical URL is the config

**Decision: `Feed.url` holds the plugin's canonical URL; no config column.**

- The URL is already the feed's identity (`@unique`), the dedup key for
  concurrent adds (`ON CONFLICT (url)`), what `/api/v1` and MCP expose and
  what the feed menu opens as the website (`siteUrl = url` for plugins). A
  GitHub URL a person pastes is a real page, so all four keep working.
- A config column (JSON) would need its own uniqueness (a unique index over
  `(pluginId, config)` or a hash), a migration, and a rule for keeping it
  and `url` in step. It buys nothing the URL cannot carry: every shape in
  the brief is a few path segments and at most two query parameters.
- Config is parsed from the URL by a pure function (no I/O), so parsing on
  every refresh costs nothing and old rows need no backfill.

### Canonicalisation

One function decides what string is stored, and it runs **before** the
known-feed lookup, so two spellings meet the same row and the second
subscriber never fetches.

`resolveTarget` in `lib/reader.ts` becomes: `normaliseUrl` (today's WHATWG
parse, http(s), no fragment), then `canonicalUrl(url)` = `pluginFor(url)`'s
canonical URL if a plugin matches, else the normalised URL unchanged.
Discovery `choices` pass through the same `canonicalUrl`. A plain feed URL
is never rewritten beyond today's rule.

Rules a plugin's canonical form must follow (the ship team writes the
GitHub table from ingest's shapes):

1. **Lossless without I/O.** Only rewrite what is certainly the same
   source: `http:` → `https:`, `www.github.com` → `github.com`, owner and
   repo lowercased (GitHub resolves them case-insensitively), trailing
   slash dropped, tracking and unknown query parameters dropped, known
   parameters in a fixed order with normalised values (e.g. trending
   `since` always explicit, `daily` when absent; discussion state filters
   lowercased and sorted).
2. **What needs a lookup stays apart.** A discussion category by path slug
   (`/discussions/categories/rfcs`) and by query name
   (`discussions_q=category:RFCs`) cannot be proven equal without asking
   GitHub (slugs are not always the lowercased name). Pick one form as
   canonical where the URL itself allows it; otherwise the two are two
   feeds. Cost: the same discussions polled twice; no data conflict.
3. **Idempotent and round-trips.** `canonical(parse(canonical(c))) ===
   canonical(c)`, and `pluginFor(canonicalUrl)` matches the same plugin.
4. **Shapes are disjoint.** A URL matches at most one plugin; the registry
   order never decides.
5. **Frozen once shipped.** Changing a canonical form after rows exist
   splits subscribers across two rows. A change ships with a Prisma
   migration that rewrites `Feed.url` and merges duplicates (move
   subscriptions and read marks to one row, delete the other), or `parse`
   keeps accepting the old form forever (see §3).

A URL on github.com that matches no shape is not a plugin URL: it goes
the plain path (fetch, parse, discovery) and ends `not_found` unless the
page announces a feed (some GitHub pages do: releases, commits). The
sentence for "unsupported GitHub URL" is interface's; if it needs a
distinct code, `fetchForAdd` can return it for a `github.com` host with no
matching shape, without any stored state.

The token is never part of `Feed.url`, `siteUrl`, `lastError` or any
entry field (§6).

## 2. The plugin interface

`matches: string` becomes a parser. Generic over its config so a plugin's
fetch is typed:

```ts
// sources/types.ts
export interface SourcePlugin<C = unknown> {
  id: string // stored on Feed.pluginId; never renamed (§3)
  // Pure, no I/O: the config for a URL this plugin owns, else null.
  parse(url: URL): C | null
  // The canonical URL for a config; stored as Feed.url and siteUrl.
  canonical(config: C): string
  // Optional feed title for a new row; a built-in source's title wins.
  title?(config: C): string
  fetchEntries(
    config: C,
    ctx: {
      fetch: SafeFetch
      known(urls: string[]): Promise<Set<string>>
      deadline: AbortSignal
    }
  ): Promise<IngestedEntry[]>
}

// sources/index.ts
export function pluginFor(
  url: string,
  registry = plugins
): { plugin: SourcePlugin; config: unknown; url: string } | undefined
```

`cursor-blog` becomes `parse: (u) => (u.href === LIST_URL ? {} : null)`,
`canonical: () => LIST_URL`; its behaviour and existing tests stay
(exact match only).

What changes around it:

- **`pluginFor`**: parses the string once, asks each plugin's `parse`,
  returns the first hit with its canonical URL. Own keys only, as
  `refreshFeed` already does.
- **`fetchForAdd(url)`**: `pluginFor(url)`; runs `fetchEntries(config, …)`
  with the same 40 s deadline and error mapping. `title` = built-in title
  ?? `plugin.title?.(config)` ?? null; `siteUrl` = canonical URL.
  **The zero-entries rule changes**: an empty result is a valid empty
  source (an RFCs category with nothing open, a trending language with
  nothing this week) and subscribes with no entries. A plugin that sees a
  broken source throws (cursor-blog already throws "the page layout
  changed" on a list without posts). One behaviour change for cursor-blog:
  an add where every post fetch failed now subscribes empty and fills on
  the next refresh, instead of `not_found`.
- **`refreshFeed`**: looks up `plugins[feed.pluginId]` as today, then
  `plugin.parse(new URL(feed.url))`; null → the same failure as a missing
  plugin (`LAST_ERROR.unknownSource`). Then `fetchEntries(config, ctx)`.
  `known()`, deadline, store, retention, backoff, `SourceStatusError`
  handling unchanged. Refresh never rewrites `url` or `title`.
- **`subscribe`**: canonicalises before `subscribeKnown` (§1). Nothing else.
- **`/api/v1`, MCP**: `pluginId` already exposed; new ids appear. No shape
  change.

Plugin ids, one per shape family: `github-discussions`, `github-trending`,
plus one per scraped site that ingest finds without a feed. Separate ids
make removing one family a one-line change with a clear failure on its
rows.

## 3. Records an older or newer build wrote

| Stored row | What happens |
| --- | --- |
| `cursor-blog`, `url = https://cursor.com/blog` (today's rows) | `parse` accepts it; unchanged. A test refreshes a row written in today's shape. |
| `pluginId` no longer registered (plugin removed or id renamed) | Today's path: `lastError = "the source isn’t supported any more"`, backoff to 24 h, `failing` at 3. Entries and read marks kept; nothing deleted. |
| Plugin registered, but `parse(feed.url)` is null (a shape removed or narrowed) | The same failure and text. |
| Canonical form changed (rule 5) | Old rows keep working only if `parse` still accepts the old form; new subscribers get a second row. Prefer a migration that rewrites and merges. |
| A site gains a real feed, the built-in source moves to it | Old plugin rows keep working while the plugin stays; new subscribers land on the feed row. Retiring the plugin needs a migration moving subscriptions (read marks don't carry: different entries). Owner's call per case. |
| `pluginId = null` row whose URL a new plugin now matches | Keeps fetching as a feed: refresh follows `pluginId`, not `pluginFor`. Only possible if that URL served a feed, in which case the plugin shape is wrong (rule: a real feed beats a plugin). |

Renaming a plugin id is a migration (`UPDATE "Feed" SET "pluginId"`), never
a code-only change.

## 4. Guids and dedup

"First version wins" (`createMany skipDuplicates` on `(feedId, guid)`)
stays for every plugin. Plugins keep the existing convention: guid = the
item's canonical `https://` URL, which `known()` relies on.

### Trending

- **One entry = one repository in that list, first time seen.** guid =
  `https://github.com/{owner}/{repo}` (lowercased as in §1).
- A repo that trends again next month, or stays for weeks, is a duplicate
  and is not shown again. The list reads as "what newly started trending".
- `publishedAt = null` (trending has no date), so `sortAt` = first seen.
  Within one batch all share `sortAt`; the reader orders ties by id, which
  is not rank order. Accepted; interface may say otherwise.
- After 500 newer entries prune a repo, it can return as new. At ~25 per
  list that is many months; accepted as "trending again".
- Alternative for the owner (Q2): guid = repo URL + period bucket
  (`#2026-10` monthly, ISO week, date), so each period's list arrives
  whole. Cost: at every boundary ~25 entries, most of them repeats.

### Discussions

- **One entry = one discussion.** guid = its URL
  `https://github.com/{owner}/{repo}/discussions/{number}`.
  `publishedAt` = the discussion's `createdAt`, never `updatedAt`, so a
  bumped old discussion does not resurface.
- Edits and new comments do not change the entry: first version wins.
  Comments are not entries. The entry links to GitHub for the live thread.
- The plugin asks for the newest discussions **by creation date**, not by
  latest activity (GitHub's default), at most 100. That keeps v1's
  retention invariant: a pruned entry is older than 500 stored ones and is
  never re-taken.
- A discussion that leaves the filter (closed, moved category) keeps its
  entry. A transferred discussion gets a new URL and reads as new; rare,
  accepted.

### Read state during a refresh

Unchanged from v1: refresh only inserts and prunes; a read mark on an
existing entry is never touched, and pruning cascades marks of pruned
entries only.

## 5. Polling cadence and the GitHub budget

**Keep hourly for every feed; no per-plugin interval, no shared
rate-limit row.**

- Discussions via the API: about one request (REST page or one GraphQL
  query of ~1 point) per feed per hour. With a token the budget is 5,000
  per hour per token, so even 500 discussion feeds spend 10 %. GraphQL
  requires a token; unauthenticated REST is 60 per hour **per IP**, and
  Vercel functions share egress IPs, so without a token the budget is not
  ours to count on (ingest to confirm).
- Trending is github.com HTML, not the API: no token, no documented
  budget, one GET per feed per hour. A monthly list polled hourly is
  wasteful but cheap; not worth a new interval unless ingest measures the
  page as heavy.
- **Rate limited**: the plugin turns GitHub's answer into today's
  mechanism, `SourceStatusError(429, headers)` with a `Retry-After`
  derived from `retry-after` or `x-ratelimit-reset` when
  `x-ratelimit-remaining` is `0` (GitHub answers 403 or 429). `refreshFeed`
  already pushes `nextFetchAt` to max(backoff, Retry-After) ≤ 24 h. Each
  GitHub feed learns the limit on its own: at worst one wasted request per
  feed per window, which at our scale is nothing. A shared row would add a
  table and a lock for no measurable gain.
- **No token configured**: discussions feeds fail with a fixed sentence
  (interface's), back off to 24 h, `failing` at 3; trending is unaffected.
  Adding a discussions URL without a token fails before any request.

## 6. Concurrency, failures and the token

| Situation | Outcome |
| --- | --- |
| Two people add two spellings of one GitHub source at once | Both canonicalise to one URL; `ON CONFLICT (url)` gives one row, both subscribed. |
| A second person adds a spelling of a stored source | `subscribeKnown` finds the canonical row; no fetch, no GitHub request. |
| Two refreshes of one GitHub feed (lease expired) | As v1: `skipDuplicates`, last writer wins on the feed row. Two API calls. |
| Mark read during a refresh | As v1, unaffected. |
| All GitHub feeds hit the limit in one hour | Each backs off to the reset time on its own row. |
| Repo missing, private or discussions disabled | Plugin throws `SourceStatusError(404, …)` (GraphQL `NOT_FOUND` arrives with HTTP 200; the plugin maps it). Add: `not_found` or interface's code. Refresh: failure with backoff, `failing` at 3; not `gone` (only 410 is). |
| Token wrong or revoked (401) | Refresh: failure "the site answered 401 Unauthorized" or interface's sentence; every discussions feed backs off. Admin's Feeds list shows it. |
| GitHub changes trending HTML | Plugin throws "the page layout changed"; failing at 3, as cursor-blog. |
| DB error in `known()` or store | As v1: throws for redelivery. |

Token rules, each with a test (§7): read from `process.env.GITHUB_TOKEN`
at request time by the GitHub plugin module only; sent only on requests
whose URL host is `api.github.com` over HTTPS; dropped on any redirect
hop (or such requests refuse redirects, ingest's choice); never in a
thrown message, `lastError`, a log line or the database.

## 7. Test plan

Runner, DB guard and serial execution as v1 (`bun run test`, local
`rssify_test`). No test reaches github.com, api.github.com or any named
site.

### Seams

- **GitHub API and pages**: the existing `fetch: SafeFetch` seam. Fakes
  record `(url, options)` per call and answer from fixtures, so a test can
  assert the URL, method, body and headers.
- **Token**: the plugin is built by a factory,
  `createGithubDiscussions({ token: () => string | undefined })`; the
  registered instance reads `process.env.GITHUB_TOKEN`. Tests pass their
  own registry through the existing `plugins` option of `refreshFeed`,
  `fetchForAdd` and `subscribe`, with `token: () => "test-token-…"` or
  `undefined`. No test sets `process.env.GITHUB_TOKEN`.
- **Time**: `now` as today, for Retry-After from `x-ratelimit-reset`.
- **safe-fetch headers/POST** (whatever ingest adds): local sockets on
  127.0.0.1 with the `lookup` seam, as today.

### Fixtures (`test/fixtures/github/`, `test/fixtures/<site>/`)

Synthetic, hand-written with invented content and example domains, keeping
only the structure the code reads. Retain plugin canonical hosts only where
a test needs them; never save live pages. Each README is one line saying it
is synthetic:

- Trending HTML: `javascript?since=monthly`, `typescript?since=monthly`,
  one language with an empty list.
- Discussions API: angular/angular RFCs page, a page with `is:open`
  filter, a repo with discussions disabled, a missing repo (GraphQL
  `NOT_FOUND` or REST 404), a rate-limited answer (status, headers
  `x-ratelimit-remaining: 0`, `x-ratelimit-reset`), a 401. API fixtures
  follow GitHub's documented schema and need no token.
- Site fixtures for any scraped site per ingest, as `cursor-blog/`.

### Cases per unit

| Area | Cases |
| --- | --- |
| `sources/index` | each sample spelling → its canonical URL (http, www, case, trailing slash, unknown and tracking params, param order, `since` default); canonical is idempotent and round-trips; every sample matches exactly one plugin; non-shapes (`/angular/angular/issues`, `/trending/developers`, other hosts, `github.com.evil.invalid`) match none; `cursor-blog` still exact-only; `pluginFor` ignores prototype names |
| `github-trending` | fixture → entries in rank order, guid = lowercased repo URL, `publishedAt` null; no `authorization` header on any request; empty list → `[]`; layout change → throws; non-2xx → `SourceStatusError` |
| `github-discussions` | request goes to `https://api.github.com/…` only, with `Authorization` carrying the fake token; ordered by creation; filters from config reach the query; entries map guid/url/title/author/`createdAt`/content as interface specifies and match `normaliseEntry`; missing repo and discussions disabled → `SourceStatusError(404)`; 403/429 with remaining 0 → `SourceStatusError(429)` with `Retry-After` from reset; 401 → `SourceStatusError(401)`; no token → throws before any fetch; the token string appears in no thrown message |
| `fetchForAdd` | plugin URL gets plugin title or built-in title; `siteUrl` = canonical; empty plugin result is a feed with no entries; plugin errors map as today |
| `subscribe` | two spellings → one `Feed` row, second subscribe makes no fetch; concurrent subscribes of two spellings → one row, both subscribed; stored `url` is canonical; `{ source }` for each new built-in; empty source subscribes |
| `refreshFeed` | stored GitHub row refreshes with config parsed from its URL; `parse` null → `unknownSource`, backoff, `failing` at 3, entries kept; unknown `pluginId` unchanged; trending: same repos again store 0, a repo that left and returned stores 0; discussion with edited body and comments stores 0 and keeps the first body; rate limit → `nextFetchAt` = reset (≤ 24 h); no token → failure, no fetch call; `lastError` never contains the token; title and url unchanged; today's `cursor-blog` row still refreshes |
| safe-fetch (per ingest's change) | added headers sent; authorization dropped (or redirect refused) on a redirect hop to another host; POST body if GraphQL; all existing guards unchanged |
| `/api/v1`, MCP | subscribe a GitHub URL through each with the fake registry; `pluginId` in the subscription shape |
| logging | console spies over the failure paths (401, 429, no token) see no token string |

### By hand (local, own port, owner's token in `.env.local`)

1. `GITHUB_TOKEN` set: add `https://github.com/angular/angular/discussions/categories/rfcs`
   (and the `is:open` spelling), both trending monthly URLs and each new
   built-in; check titles, entries, the Website link.
2. Add a second spelling of a stored source; it opens the same feed with
   no wait.
3. `bun --env-file=.env.local scripts/refresh.ts`; nothing duplicates.
4. Remove `GITHUB_TOKEN`, restart: adding a discussions URL shows
   interface's sentence; refresh marks the feed failed with the sentence,
   trending still refreshes.
5. Check server output for the token string: none.
6. Stop the dev server.

## 8. Env

| Name | Default | Notes |
| --- | --- | --- |
| `GITHUB_TOKEN` | unset (empty in `.env.example`) | Owner's decision (Q1). Fine-grained PAT, public repositories read-only, no extra permissions. Server only; never `NEXT_PUBLIC_`. CI needs none. |

No other variable, port or schema change. Nothing about OPML changes;
importing rsshub URLs is not in scope.

## Open questions

- **Q1 (owner)**: `GITHUB_TOKEN`. (a) Set a fine-grained read-only PAT in
  Vercel; discussions work. (b) No token: unauthenticated REST at 60/h per
  shared Vercel IP, unreliable; discussions likely fail often. (c) No
  token and no discussions plugin; trending only. Default: (a).
- **Q2 (owner)**: trending recurrence. (a) guid = repo URL, a repo appears
  once; (b) one entry per repo per period. Default: (a).
- **Q3 (lead/ingest)**: which discussion filter spellings are supported,
  and which form of a category is canonical (§1 rule 2).
- **Q4 (lead/interface)**: does an unsupported GitHub URL or a missing
  token need its own add error code, or do they read as `not_found` with a
  sentence keyed on host? Either needs no stored state.
- **Q5 (lead)**: accept the `fetchForAdd` change "an empty plugin result
  subscribes" and its one cursor-blog consequence (§2).
