# RSSF-22 ingest draft: what the named sites serve, and what to fetch

Ingest architect's answer to the brief's Ingest questions. Every number
below was measured on 2026-10-22 from a local machine with curl, Node's
fetch (undici) and Deno, using our UA `rssify/1.0
(+https://github.com/IKatsuba/rssify)` and our feed-preferring `Accept`
unless a row says otherwise. Nothing ran against Vercel, Neon or a queue;
no token was used. Excerpts of the pages the plugins read are in
`drafts/ingest/` (each names its source URL and capture date).

## 0. The answer in one table

| rsshub route | What we fetch | Kind |
| --- | --- | --- |
| `nodejs/blog/en` | `https://nodejs.org/en/feed/blog.xml` | **native RSS**, built-in source |
| `langchain/blog` | `https://www.langchain.com/blog/rss.xml` | **native RSS**, built-in source |
| `github/discussion/angular/angular/Open/RFCs` | `https://github.com/angular/angular/discussions/categories/rfcs.atom` | **native Atom** (GitHub's own); paste rule, no plugin |
| `github/trending/monthly/{javascript,typescript}` | `https://github.com/trending/<lang>?since=monthly` HTML | **plugin** `github-trending` (parameterised by URL) |
| `anthropic/news` | `https://www.anthropic.com/news` + post pages | **plugin** `anthropic-news` |
| `anthropic/engineering` | `https://www.anthropic.com/engineering` + post pages | **plugin** `anthropic-engineering` |
| `firefox/release/desktop` | `https://www.firefox.com/en-US/releases/` + notes pages | **plugin** `firefox-releases` |
| `bytes` | `https://bytes.dev/archives` + issue pages | **plugin** `bytes` |
| `hacks.mozilla.org/feed/`, `tympanus.net/codrops/feed/` | — | **out of reach**: blocked for every non-browser client (§5) |

Two native feeds, one GitHub Atom family, five plugins (one of them
parameterised). **No GitHub API call is needed, so no token, no POST and
no change to safe-fetch.** That is the main finding; §3 and §4 explain it.

## 1. Sites with a real feed (Q1)

### 1.1 Node.js blog: native RSS

- `https://nodejs.org/en/blog` → 200 `text/html`; it advertises
  `<link rel="alternate" type="application/rss+xml"
  href="https://nodejs.org/en/feed/blog.xml">`. Pasting the blog URL
  already works through today's discovery.
- `https://nodejs.org/en/feed/blog.xml` → 200 `application/xml`,
  Cloudflare, RSS 2.0 (generator `jpmonette/feed`), **1,065 items, 325 KB**,
  from 2026-10-21 back to 2011-03-18. No `ETag`, no `Last-Modified`;
  `cache-control: public, max-age=0, must-revalidate`, so every poll is a
  full 325 KB download. Within the 10 MB cap; `storeEntries` keeps the
  newest 100 by `sortAt`.
- Sample item (as served):
  ```xml
  <item>
    <title><![CDATA[Wednesday, October 21, 2026 Security Releases]]></title>
    <link>https://nodejs.org/en/blog/vulnerability/october-2026-security-releases</link>
    <guid isPermaLink="false">/blog/vulnerability/october-2026-security-releases?1792620000000</guid>
    <pubDate>Wed, 21 Oct 2026 22:00:00 GMT</pubDate>
  </item>
  ```
  The guid carries the publish time in ms after `?`; it is stable while
  the post's date is. Items have no description, so the entry page shows
  the no-text state with Open original. That is what the site gives.
- **Built-in source** `nodejs-blog` → `https://nodejs.org/en/feed/blog.xml`.

### 1.2 LangChain blog: native RSS, not advertised

- `blog.langchain.com` and `blog.langchain.dev` both 301 → 301 →
  `https://www.langchain.com/blog` (200 HTML, Webflow, **no**
  `<link rel=alternate>`). Pasting the blog URL today gives `not_found`.
- `https://www.langchain.com/blog/rss.xml` → 200
  `application/rss+xml; charset=utf-8`, Webflow generator,
  **100 items, 79 KB**, `Last-Modified` present (a conditional GET with it
  still answered 200, so do not count on 304). `/rss.xml` and `/blog/feed`
  are 404.
- Sample item: `<title>How Numan Built an Eval-First AI Health Coach…</title>`,
  `<link>` and `<guid>` both the post URL, `<description>` one sentence,
  `<pubDate>Mon, 19 Oct 2026 16:44:34 GMT</pubDate>`, `media:content`
  image. No full content; summary only.
- **Built-in source** `langchain-blog` → `https://www.langchain.com/blog/rss.xml`.

### 1.3 Sites without a feed

Checked: `<link rel=alternate>` on every list page, `/rss.xml`, `/feed`,
`/feed.xml`, `/rss`, `/news/rss.xml`, sitemaps.

| Site | Result |
| --- | --- |
| anthropic.com/news, /engineering | 200 HTML, no alternate link; `/rss.xml`, `/news/rss.xml`, `/feed` 404. `sitemap.xml` exists (570 URLs, 277 `/news/*`, 202 `/research/*`) but has only `lastmod`, and cannot tell an engineering post from other research. |
| bytes.dev | `/`, `/archives` 200 HTML, no alternate link; `/rss.xml`, `/feed.xml`, `/rss` 404; sitemap index lists one `sitemap-0.xml`. |
| Firefox release notes | `mozilla.org/en-US/firefox/releases/` and `/firefox/notes/` 301 → 302 → `www.firefox.com/en-US/…`; alternates are only `hreflang`; `releases/notes.rss` 404 on both hosts. Mozilla's `product-details.mozilla.org/1.0/*.json` give versions and dates but no notes. |
| GitHub trending | 200 HTML, no alternate link, no API (§3). |

## 2. Sites without a feed: what the plugins read (Q2)

Common to all four: list page → post links in document order → for URLs
`known()` lacks, at most 10 per run, 4 at a time, fetch the post page,
exactly as `cursor-blog` does today; guid is the post URL with query and
hash stripped; one 40 s deadline. A failed post fetch is skipped for the
run. Zero post links on the list page throws "the page layout changed".
Dates that are bare calendar days are read as UTC midnight.

### 2.1 Anthropic Engineering (`anthropic-engineering`)

- List `https://www.anthropic.com/engineering` → 200, 55 KB, server-rendered
  (Next.js, Cloudflare, `s-maxage=300`). **24 `article` elements**, each
  with `time` (text only, e.g. `Apr 8, 2026`, no `datetime`) and `h3 a`.
  Excerpt: `drafts/ingest/anthropic-engineering-cards.html`.
- **The posts now live under `/research/…`**, not `/engineering/…`
  (e.g. `/research/managed-agents`). A selector on `/engineering/` would
  match nothing. Rule: every `article`'s `h3 a[href]`, same origin.
- Post page (`/research/redesigning-source-control`): `og:title`,
  `meta[name=description]`, `article:published_time`
  (`2026-10-13T00:00:00.000Z`), JSON-LD `datePublished`,
  `time[dateTime]`. Body: the parent of the first `p.post-text` (classes
  `post-text`, `post-heading`, `post-section` are plain names; the
  container's own class `Body-module-scss-module__PA4F1q__body` is a CSS
  module hash and must not be used). Measured 22 KB of text.
- Entry: title `og:title`; summary meta description; content that body;
  date `article:published_time` → list `time` text → null.

### 2.2 Anthropic News (`anthropic-news`)

- List `https://www.anthropic.com/news` → 200, 64 KB. **Not** a uniform
  card list: a featured grid (`FeaturedGrid-…__tileLink`, 3–4 items) and a
  table (`TableView-…__title-link`, ~18 rows), with topic links
  (`TopicLink-…`) to `/news/announcements`, `/news/policy`, etc. mixed in.
  Excerpt: `drafts/ingest/anthropic-news-rows.html`.
- **Model launches link outside `/news/`**: the featured tiles
  "Introducing Claude Opus 5.5" etc. go to `/claude-opus-5-5`, whose page
  has `og:type=website` and **no** `article:published_time`.
- Rule: `a[href]` whose class contains `title-link` or `tileLink`,
  de-duplicated in document order, same origin. Measured: 24 URLs, all
  posts, no topic pages; 19 under `/news/`, four launch pages at the root
  (`/claude-opus-5-5`, `/claude-fable-and-mythos-5-1`, …) and one
  `/features/ebola-response`. A path rule like `^/news/` would drop the
  launches. This leans on the component-name half of CSS-module classes
  (`TableView-module…`, stable across builds so far) and not on the hash.
  It is the most fragile selector in this design; say so in the plugin's
  test and in §6.
- Post page (`/news/cyber-verification-program`): same meta and
  `p.post-text` body as Engineering; `article:published_time`
  `2026-10-06T00:00:00.000Z`. Launch pages: title from `og:title`, date from
  the list tile's `time` text, body from `p.post-text` when present (2
  found on `/claude-opus-5-5`), else summary only.
- The page also embeds ~156 posts as Next.js flight data
  (`\"slug\":{\"current\":…},\"publishedOn\":\"2026-10-16\"`). Not used:
  it is an undocumented React payload, harder to read safely than HTML,
  and its slugs do not say which path they live under.

### 2.3 Bytes (`bytes`)

- List `https://bytes.dev/archives` → 200, 63 KB, Vercel, weak `ETag`.
  **531 links** `a[href^="/archives/"]`, newest first; each card holds
  date `MM/DD/YYYY` (e.g. `10/20/2026`), "Issue 531", the title and an
  image. Excerpt: `drafts/ingest/bytes-archive-cards.html`. The first card
  sits in a "Latest Issue" section; the rest in `li`. Rule:
  `a[href^="/archives/"]` with a numeric path, de-duplicated.
- The `MM/DD/YYYY` order is confirmed by the issue page, which prints
  `October 20, 2026` for `10/20/2026`. Read only that exact pattern;
  anything else is no date.
- Issue page `/archives/531` → 200, 17 KB: `og:title` "Bytes #531 - A
  TypeScript Compiler Journey from Hell", `meta[name=description]`, no
  published-time meta, no `article`/`main`/`.prose`, no class on the
  content block. Content: the parent of the first `p` whose text starts
  `Today’s issue` (31–42 children, measured on #531 and #400). If that `p`
  is missing, content is null and the summary stands.
- Entry: title `og:title`; summary description; date list card; guid URL.

### 2.4 Firefox release notes (`firefox-releases`)

- List `https://www.firefox.com/en-US/releases/` (the mozilla.org URL
  redirects here) → 200, 12 KB compressed, **806 links**
  `/firefox/<version>/releasenotes/`, newest major first, but within a
  major `158.0` precedes `158.0.1`. **ESR versions are mixed in**
  (`153.0esr`, `153.1.0` … `153.5.1`). Desktop release only: versions
  matching `^\d+\.0(\.\d+)?$`.
- Notes page `/en-US/firefox/158.0/releasenotes/` → 200: `.c-release-version`
  `158.0`, `.c-release-date` `October 13, 2026`, notes in `.c-release-notes`
  (19 KB of HTML for a major, 4 KB for a dot release). These are plain BEM
  names. Excerpt: `drafts/ingest/firefox-notes-header.html`.
- Entry: title `Firefox <version>`; date `.c-release-date`; content
  `.c-release-notes`; summary its first 300 characters (normal
  normalisation). Document order is not date order; `storeEntries` sorts
  by `sortAt`, so that is fine.
- The first run sees ~100 desktop versions and takes the first 10 in
  document order (the newest five majors with their dot releases).

### 2.5 What breakage looks like (all four)

| Change | Symptom | Handling (existing paths) |
| --- | --- | --- |
| List markup renamed | 0 post links | throw "the page layout changed" → failing after 3 |
| Post markup renamed | posts with title from `og:title`, no body | entries still stored with summary; noticed only by reading. A test fixture per plugin catches it in CI only when fixtures are refreshed |
| A post 404s / times out | skipped this run | retried next run, it is still unknown |
| List page 403/429/5xx | `SourceStatusError` | backoff, `Retry-After` honoured |
| Site starts serving a feed | nothing | the owner switches the built-in source to the feed (a code change) |

## 3. GitHub (Q3)

### 3.1 Discussions: GitHub serves Atom; no plugin, no API

Measured, unauthenticated, our UA:

| URL | Status | Body |
| --- | --- | --- |
| `github.com/angular/angular/discussions.atom` | 200 `application/atom+xml` | 25 entries, 789 KB (RFC bodies are long) |
| `github.com/angular/angular/discussions/categories/rfcs.atom` | 200 | 25 entries, title "Recent discussions in angular/angular, category: rfcs" |
| `github.com/vercel/next.js/discussions.atom` | 200 | 25 entries, 132 KB |
| `github.com/vercel/next.js/discussions/categories/ideas.atom` | 200 | 25 entries, different set (category filter works) |
| `…/discussions/categories/nope.atom` (unknown category) | 200 | a valid feed with **0 entries** |
| `…/discussions.atom?discussions_q=is%3Aopen` | 200 | **query ignored**: same entries as without it |
| `…/categories/ideas.atom?discussions_q=is%3Aunanswered` | **302** to the HTML page | not a feed |
| `github.com/IKatsuba/rssify/discussions.atom` (discussions off) | 404 | |
| missing owner/repo | 404 | |

- Entries: `<id>tag:github.com,2008:9397061</id>` (stable per
  discussion), `<link>` the discussion URL, `<published>` creation time,
  `<updated>` last activity, `<author>`, `<content type="html">` the
  rendered body. Excerpt: `drafts/ingest/github-discussions-category.atom.head`.
- **Order is by last activity, not creation**: next.js `ideas` listed a
  discussion published 2024-12-23 second, because it was updated
  2026-10-21. With first-version-wins and `sortAt = publishedAt`, an old
  discussion that gains a comment shows up once, the first time it is
  seen, dated by its creation, so it lands low in the list. Acceptable;
  state decides if it is not.
- Weak `ETag` is sent, but a repeat with `If-None-Match` answered 200
  (the tag changes per request). No 304 to count on.
- The HTML pages (`/discussions`, `/discussions/categories/rfcs`) **do
  not** advertise the Atom URL with `<link rel=alternate>`, so pasting the
  page URL today ends in `not_found`; pasting the `.atom` URL already
  works today with no change.
- **What the owner's rsshub route did that Atom cannot**: the `Open`
  state filter. There is no state filter on the Atom feed. For a reader
  that keeps new entries as they appear, the difference is the first fetch
  (up to 25 recent discussions, some closed) and closed discussions that
  gain activity. New discussions are open when created.

**Recommendation**: no plugin. A paste rule in the add path maps a
GitHub discussions page URL to its Atom URL before fetching:

```
https://github.com/{owner}/{repo}/discussions[/]                      → …/discussions.atom
https://github.com/{owner}/{repo}/discussions/categories/{slug}[/]    → …/discussions/categories/{slug}.atom
(query and hash dropped; whether to lowercase owner/repo/slug is state’s canonicalisation call, not measured here)
```

Anything else under `/discussions` (a single discussion `/discussions/123`,
a search `?discussions_q=…`) is either mapped by dropping the query or
refused with a sentence; that is interface's and state's call (§6, Q-I1).
An unknown category gives an empty, valid feed: the add succeeds with no
entries. Checking the category first would need the HTML page or the
API; not proposed.

### 3.2 REST and GraphQL, measured, and why neither is used

- `GET https://api.github.com/repos/angular/angular/discussions` **exists**
  and works without a token (200, `x-ratelimit-limit: 60`,
  `x-ratelimit-resource: core`). It returns `body` (Markdown) or
  `body_html` with `Accept: application/vnd.github.html+json`, `state`,
  `category.slug`, `created_at`, `updated_at`, `comments`.
  **But** `sort`, `direction`, `category` and `state` query parameters are
  all ignored: every variant returned the same oldest-first list (#43784
  from 2021 first). Newest-first needs the `Link: rel="last"` page, i.e. 2
  requests, and category/state filtering then happens on our side over at
  most 100 items, which misses matches in busy repos.
  `/repos/{o}/{r}/discussions/categories` is 404.
- GraphQL `POST https://api.github.com/graphql` without a token: **403,
  `x-ratelimit-limit: 0`** (`/rate_limit` reports `graphql.limit: 0`).
  GraphQL can sort, filter by category and state and answered, but only
  with a token, a POST and a JSON body.
- Rate limits: REST unauthenticated 60/hour per IP (measured); with a
  token 5,000/hour (documented). On Vercel the egress IPs are shared with
  other tenants, so 60/hour per IP is not ours to spend; unauthenticated
  REST from Vercel is not dependable.

Atom gives what the owner reads today (a category's discussions, newest
activity first, rendered HTML) with one GET and no budget of its own.

### 3.3 Trending: HTML only, scrapable (`github-trending`)

- No API exists for trending (none in the REST or GraphQL schema).
- `https://github.com/trending/javascript?since=monthly` → 200
  `text/html`, 51 KB, server-rendered. Rows: `article.Box-row` (17 for
  JS monthly; 19 TS monthly, 9 all-languages daily, 10 C++ weekly, 13
  Python daily zh; GitHub returns up to 25). Per row (excerpt
  `drafts/ingest/github-trending-row.html`):

  | Field | Selector | Example |
  | --- | --- | --- |
  | repo | `h2 a[href]` | `/cloudflare/security-audit-skill` |
  | description | `p` (first) | "A coding-agent skill for multi-phase security audits…" |
  | language | `[itemprop=programmingLanguage]` | JavaScript |
  | stars | `a[href$="/stargazers"]` | 37,959 |
  | forks | `a[href$="/forks"]` | 2,372 |
  | period stars | `span.d-inline-block.float-sm-right` | "16,694 stars this month" |

  These are Primer utility classes and `itemprop`, not build hashes.
- URL shapes measured:

  | URL | Result |
  | --- | --- |
  | `/trending` | all languages, daily |
  | `/trending/{lang}` | `lang` is GitHub's slug, percent-encoded: `javascript`, `typescript`, `c%2B%2B` (measured) |
  | `?since=daily\|weekly\|monthly` | absent = daily |
  | `?since=yearly` (anything else) | **silently daily** ("Today") |
  | `&spoken_language_code=zh` | filters; empty value = any |
  | `/trending/notalanguage` | **200** with 0 rows and `.blankslate` "It looks like we don’t have any trending repositories for your choices." |
  | `/trending/developers` | a different page (developers); left out |

  Canonical form for state to decide (my proposal):
  `https://github.com/trending[/{lang}]?since={daily|weekly|monthly}[&spoken_language_code={code}]`,
  `since` always written, empty `spoken_language_code` dropped, `lang`
  lowercased as GitHub links it. Refuse a `since` outside the three values
  rather than store a URL that silently means daily.
- Entries: **one request per refresh, no per-repo fetches.** Title
  `owner/repo`; url `https://github.com/owner/repo`; summary the
  description; content built from the row (escaped description, language,
  stars, forks, "N stars this month"); `publishedAt` null (the page has no
  date, and inventing one is against §6.6), so `sortAt` = first seen and
  document order breaks ties, which keeps GitHub's rank order. Guid is
  state's question (Q3 in the brief); ingest's default is the repo URL, so
  a repo shows once, the first time it trends; a per-period guid
  (`…#monthly-2026-10`) would show it again each period. The plugin can
  produce either.
- Empty versus broken: 0 rows **and** `.blankslate` present → success with
  0 entries (refresh) / `not_found` (add, as today). 0 rows and no
  blankslate → "the page layout changed".
- Not in robots.txt's disallow list (`/trending` is allowed; checked
  2026-10-22).

### 3.4 Other shapes, left out

Issues and PRs by label: GitHub has no Atom for them (only REST/search,
search unauthenticated is 10/min), so they would need the API and a token.
Releases, tags, commits already have Atom (brief non-goal). Left out.

### 3.5 Cost per refresh and limits

| Shape | Requests per refresh | Size | API budget |
| --- | --- | --- | --- |
| discussions `.atom` | 1 GET github.com | 0.1–0.8 MB | none |
| trending HTML | 1 GET github.com | ~50 KB | none |

Hourly per feed, both stay well under anything. github.com HTML and Atom
have no published unauthenticated limit; GitHub applies undocumented
secondary limits to web traffic, and Vercel's shared egress IPs may meet
them before we do. **This cannot be measured locally.** The existing paths
already cover it: a 429 or 403 from github.com is a list-page/feed status,
backed off with `Retry-After` honoured, failing after 3. Headers to
honour: `retry-after` (existing). `x-ratelimit-*` only appear on
api.github.com, which we do not call.

## 4. The token through safe-fetch (Q4)

**Not needed**: nothing above calls api.github.com. Default: no
`GITHUB_TOKEN`, no safe-fetch change, no POST.

If the owner later wants what only GraphQL gives (state filter `is:open`,
answered, issues by label), these are the options, none recommended now:

1. **Per-call headers in safe-fetch** (`headers?: Record<string,string>`,
   `method`, `body`), with safe-fetch itself dropping `authorization` on
   any hop whose host is not exactly `api.github.com` (a redirect must not
   carry it). Smallest change; the host rule lives in one place.
2. **A tiny `githubFetch` wrapper** that refuses any URL whose host is not
   `api.github.com`, sets `redirect` handling to refuse cross-host hops,
   and calls safe-fetch with the extra header. Safe-fetch still needs
   `method`/`body`/`headers` for GraphQL.
3. **REST only, GET only** with option 1's header; no POST. Gets the
   oldest-first list problem of §3.2.

The token would be read from env inside the plugin call, never logged,
never in `lastError` (GitHub's error bodies do not echo it; our
`answeredError` uses only the status).

## 5. The 403s: hacks.mozilla.org and tympanus.net (Q5)

Measured on `/feed/` of both:

| Variant | hacks.mozilla.org | tympanus.net/codrops |
| --- | --- | --- |
| our UA + our Accept (HTTP/2) | 403 | 403 |
| our UA, `*/*`; HTTP/1.1; IPv4 and IPv6 | 403 | 403 |
| no UA; curl's UA; `rssify/1.0` alone | 403 | 403 |
| Feedly-, NetNewsWire-, Miniflux-like UAs | 403 | 403 |
| a Firefox UA, with browser `Accept` and `Accept-Language` | 403 | 403 |
| Node fetch (undici, OpenSSL), Deno fetch (rustls) | 403 | 403 |
| another network (Anthropic's WebFetch) | 403 | 403 |
| other paths: `/`, `/feed/atom/`, `?feed=rss2`, `/wp-json/wp/v2/posts` | 403 | 403 |

- hacks.mozilla.org: `server: cloudflare`, body nginx "403 Forbidden"
  (106 B). blog.mozilla.org `/feed/` is the same.
- tympanus.net: Cloudflare "Attention Required! | Cloudflare", "Sorry,
  you have been blocked" (a WAF block, not a JS challenge page).

**Verdict**: not the UA, not the Accept, not HTTP version, not one TLS
stack (three different stacks are refused), and not only this machine's
IP (two networks). Both sites refuse **every non-browser client, on every
path**, including a browser UA string; what passes is a real browser
(TLS and HTTP/2 fingerprint plus whatever the block rules check).
Getting through would mean impersonating a browser's TLS fingerprint,
which we do not do and safe-fetch cannot. **Recommendation: change no
headers, globally or per host; call both sites out of reach.** They show
the usual failing marker with "the site answered 403 Forbidden".

Alternatives that exist:

- Codrops: `https://feeds.feedburner.com/tympanus` → 200 RSS, 10 items,
  self link `tympanus.net/codrops/feed/`. But its newest item is
  **2026-09-14** (5 weeks old); whether Feedburner is stale or Codrops has
  not posted since cannot be told from here. The owner can compare in a
  browser (Q-O2).
- Mozilla Hacks: no mirror found (`feeds.feedburner.com/mozhacks` and
  variants 404).
- Asking the sites to allow the UA is the only clean fix; it is the
  owner's, not ours.

## 6. Failure cases for the new sources

| Case | What happens |
| --- | --- |
| Native feed malformed / empty | as today (`not_found` on add, failing on refresh; an empty valid feed is fine) |
| Huge: nodejs 325 KB, angular RFC Atom 789 KB | under 10 MB; newest 100 kept |
| Moved: LangChain domains, mozilla.org → firefox.com | redirects followed (≤ 5); stored URL is the built-in's final URL, so no redirect per poll |
| Gone: repo deleted or discussions turned off | 404 → failing; GitHub does not send 410 |
| Unknown discussions category | empty valid feed; subscribed, never any entries |
| Trending: unknown language / empty period | blankslate → 0 entries; add says `not_found` |
| Trending markup changed | 0 rows, no blankslate → "the page layout changed" |
| Anthropic News class names rebuilt | 0 links → "the page layout changed" (the most likely plugin to break) |
| Slow | one 15 s (feed) or 40 s (plugin) deadline, as today |
| Duplicate delivery | unchanged: `skipIfFreshWithin`, `(feedId, guid)` dedup |
| github.com rate-limits Vercel IPs | 429/403 → backoff with `Retry-After`; cannot be measured locally |
| A site needs a browser (hacks, codrops) | 403 → failing; out of reach by design |

## 7. What ingest needs from state and interface

- **The plugin needs its feed's URL.** `fetchEntries` gets no URL today;
  `github-trending` reads language/since/spoken language from it. State's
  interface change should pass `url` (the stored `Feed.url`) in the ctx.
- **The discussions paste rule** is URL rewriting in the add path, not a
  plugin and not discovery. Where it lives (next to `normaliseUrl`, or a
  `feedUrlFor` step before fetch) is state's call.
- Plugin `matches` for trending must be a pattern, not one URL.
- Built-in source list additions (ids proposed): `nodejs-blog`,
  `langchain-blog`, `anthropic-news`, `anthropic-engineering`,
  `firefox-releases`, `bytes`. GitHub sources are by paste only.

## 8. Test plan (ingest's part)

Fixtures under `test/fixtures/`, cut from the excerpts in
`drafts/ingest/` plus the full captures the ship team takes once:

- Each plugin: list fixture → expected post URLs in order; post fixture →
  expected entry; list with 0 links → "the page layout changed"; a 404 post
  skipped. Anthropic News: featured launch tile without
  `article:published_time` takes the list date; topic links excluded.
- Firefox: ESR and `esr` versions excluded; `158.0` and `158.0.1` both kept.
- Bytes: `10/20/2026` → 2026-10-20; a malformed date → null.
- Trending: rows → entries in rank order with null `publishedAt`;
  blankslate → 0 entries; neither → layout changed; URL canonicalisation
  table of §3.3.
- Discussions paste rule: each URL shape of §3.1 → its `.atom`, others
  refused or mapped as decided; a `.atom` URL passes through.
- No test reaches github.com, api.github.com or any site.

## 9. Open questions

For the owner (through the lead):

- **Q-O1. Discussions state filter.** rsshub read only *open* RFCs. GitHub's
  Atom has no state filter; matching it needs GraphQL with a
  `GITHUB_TOKEN` (§4). Options: (a) Atom, all states, no token
  **(default)**; (b) add `GITHUB_TOKEN` and a GraphQL plugin for filtered
  discussions; (c) REST without token, ruled out (oldest-first, 60/hour per
  shared IP).
- **Q-O2. Codrops via Feedburner.** Subscribe to
  `feeds.feedburner.com/tympanus` instead (newest item 2026-09-14), or
  leave Codrops failing. Default: leave it; the owner checks in a browser
  whether Codrops posted after 2026-09-14.
- **Q-O3. Hacks and Codrops stay out of reach** (no browser impersonation).
  Default: yes.

For state and interface:

- **Q-I1.** A pasted discussions URL with a search query
  (`?discussions_q=is:open`): drop the query and subscribe to all states,
  or refuse with a sentence. Ingest's default: refuse, because silently
  dropping the filter subscribes the person to something else than they
  pasted.
- **Q-S1.** Trending guid: repo URL (once ever) or repo URL + period.
- **Q-S2.** Whether the trending canonical URL always carries `since`.
