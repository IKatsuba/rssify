# RSSF-22 design: sources for the rsshub-only feeds

The merged design for an OPML of tech news feeds read through a
private rsshub, and for the two feeds that answer 403. The owner's rule
governs every choice: as simple as possible, nothing clever.

The record stays in `drafts/`: `brief.md` (the task), `ingest.md` (what
every site served on 2026-10-22), `interface.md` (the dialog, titles,
sentences, entries) and `state.md`
(storage, guids, cadence, tests). Where this file and a draft disagree,
this file wins. The drafts were written in parallel: state and interface
assumed a GitHub API path that ingest's measurements removed, and the
owner then dropped GitHub Discussions (§13).

Contents: 1 The answer · 2 What a person sees · 3 Sentences · 4 Target
resolution and the plugin interface · 5 The sources · 6 Refresh, cost and
limits · 7 Schema, auth, env · 8 Failure cases · 9 Test plan · 10 Build
units · 11 Decisions · 12 Critic findings · 13 Owner's answers.

---

## 1. The answer

| rsshub route | What rssify reads | Kind |
| --- | --- | --- |
| `nodejs/blog/en` | `https://nodejs.org/en/feed/blog.xml` | native RSS → built-in source `nodejs-blog` |
| `langchain/blog` | `https://www.langchain.com/blog/rss.xml` (not advertised) | native RSS → built-in source `langchain-blog` |
| `github/trending/monthly/{javascript,typescript}` | `https://github.com/trending/<lang>?since=monthly` HTML | plugin `github-trending`, parameterised by URL |
| `anthropic/engineering` | `https://www.anthropic.com/engineering` + post pages | plugin `anthropic-engineering` |
| `anthropic/news` | `https://www.anthropic.com/news` + post pages | plugin `anthropic-news` |
| `bytes` | `https://bytes.dev/archives` + issue pages | plugin `bytes` |
| `firefox/release/desktop` | `https://www.firefox.com/en-US/releases/` + notes pages | plugin `firefox-releases` |
| `github/discussion/angular/angular/Open/RFCs` | — | **dropped by the owner** (Q1) |
| `hacks.mozilla.org/feed/`, `tympanus.net/codrops/feed/` | — | **out of reach** with every client tested; no header change (Q3, Q4) |

**No GitHub API call, no `GITHUB_TOKEN`, no change to safe-fetch, no
schema change, no new env variable, no new dependency.**

The GitHub family is one URL-parameterised plugin: trending by language,
period and spoken language. Ingest measured what else falls out of
GitHub (ingest §3.2–§3.4), and nothing more fits without the API:

- Discussions have GitHub's own Atom, but the owner dropped them.
- Issues and PRs by label have no Atom; they would need the API and a
  token.
- Releases, tags and commits already have GitHub Atom feeds that
  discovery finds from the page.

## 2. What a person sees and does

No new screen, form, key, setting or error code (interface §1, §4, §5,
cut down).

### 2.1 Add a feed

- **The same URL field.** A trending URL copied from the browser works:
  `github.com/trending` or `github.com/trending/{lang}`, with
  `?since=daily|weekly|monthly` and an optional `&spoken_language_code=`.
- **The dialog description** gains a clause in unit 4: "Paste a feed URL
  or a website’s address. We’ll find its feed. GitHub Trending pages work
  too."
- **Built-in sources**: six new entries beside the two that exist,
  ordered by title, each with the `RssIcon`. Ids are stable once shipped,
  because they are `{ source }` in actions, `/api/v1` and MCP.

  | id | title | note |
  | --- | --- | --- |
  | `anthropic-engineering` | Anthropic engineering | anthropic.com/engineering — no feed of its own |
  | `anthropic-news` | Anthropic news | anthropic.com/news — no feed of its own |
  | `bytes` | Bytes | bytes.dev — no feed of its own |
  | `claude-code` | Claude Code blog | (unchanged) |
  | `cursor-blog` | Cursor blog | (unchanged) |
  | `firefox-releases` | Firefox release notes | firefox.com — desktop release notes, no feed of their own |
  | `langchain-blog` | LangChain blog | The LangChain blog’s own feed |
  | `nodejs-blog` | Node.js blog | nodejs.org — the Node.js blog’s own feed |

  Trending is not a built-in source: it is parameterised, and a fixed
  "JavaScript monthly" item would be the owner's OPML, not a source for
  everyone.
- **The source list scrolls.** Eight items run past a phone's height, so
  the `ItemGroup` of sources takes shadcn's scrollable-dialog pattern
  (`max-h-[50vh] overflow-y-auto -mx-4 px-4`). The URL field stays on top.
- **Pasting a site's own page.** This is what was measured, and nothing
  further is promised (critic 3):
  - `nodejs.org/en/blog` is discovered to the built-in feed URL and lands
    on the same row.
  - The plugin pages accept the spellings in §4.3: host with or without
    `www`, trailing slash, and the mozilla.org address of the Firefox list.
  - `www.langchain.com/blog` announces no feed and stays `not_found`, so
    the person picks the built-in source.

  Subscribed badges compare `Feed.url` with the built-in `url`, which is
  canonical by construction; a test asserts it.

### 2.2 Titles

- Plain feeds keep the feed's own title, as today.
- A plugin feed gets its title at add: the built-in title, else
  `plugin.title(url)`, else null. Refresh never changes a plugin feed's
  title.
- Trending titles come from the URL alone, with GitHub's slugs as they
  are and no lookup table (critic 12):
  - "GitHub trending · javascript · this month"
  - "GitHub trending · today" (no language)
  - "GitHub trending · c++ · this week · zh" (decoded slug; the spoken
    language as its code)

  They lead with "GitHub trending", so they sort together in the sidebar.
- `siteUrl` of a plugin feed is its canonical URL, so the feed menu's Open
  website opens the page the person pasted.

### 2.3 How entries read

- **A trending repository**, as rsshub's route gave it (owner Q2):

  | Field | Value |
  | --- | --- |
  | title | `owner/name` |
  | summary | the repo description |
  | content | `<p>{description}</p><p>{language} · {stars} stars · {forks} forks · {periodStars}</p>`, escaped and built from the trending row; the language part is left out when GitHub shows none |
  | author | null |
  | `publishedAt` | null, so the date shown is when rssify first saw the repo |
  | url and guid | `https://github.com/owner/name`, lowercased in the guid |

  A repo therefore appears once ever. Rows of one fetch share `sortAt`,
  and the reader orders ties by id, so **rank order is not kept**
  (critic 11).
- **Plugin sites** read as Cursor's do today: the title, the meta
  description as summary, and the article body as content. A page without
  the expected body stores summary only (§5.3).
- **Node.js** items have no description: the entry shows the no-text state
  with Open original. That is what the site serves.

### 2.4 Screen checks for the ship units

| Unit | Check |
| --- | --- |
| 2 | The dialog with eight sources (desktop, phone with the list scrolled, dark) |
| 4 | A trending feed's list and one entry, desktop and phone |
| 5–7 | Each plugin site's list and one entry |

## 3. Sentences

No new add code and no new sentence at add. A trending URL rssify can't
honour is simply not a plugin URL (§4.3). It takes the plain path, where
the HTML page announces no feed, and reads as today's `not_found`: "We
couldn’t find a feed at that address. Try the site’s feed URL directly."
That covers a `since` other than `daily`, `weekly` or `monthly` (GitHub
silently shows daily) and `/trending/developers`. Interface's
GitHub-specific codes (`unsupported`, `no_discussions`, `no_token`,
`rate_limited`) and its GitHub `lastError` texts are dropped: each one
described the API or discussions.

The one new refresh failure text is "none of the new posts could be read"
(§5.3), lower case like the existing ones.

MCP `subscribe`'s description gains "(a GitHub Trending page works too)"
in unit 4. No other surface changes:

- Settings and Admin are untouched.
- `/api/v1` and MCP shapes are unchanged; `pluginId` is already exposed,
  and new ids simply appear.

## 4. Target resolution and the plugin interface

### 4.1 One target contract (critic 2)

`lib/ingest/target.ts` exports `canonicalUrl(input: string, plugins)`,
which returns `string | null` (null is `invalid_url`). It is pure (no
I/O), idempotent, and runs **before** the known-feed lookup:

1. `normaliseUrl`, as today: http(s) only, fragment dropped.
2. The first plugin whose `canonical(url)` is not null gives the URL.
   Shapes are disjoint, so registry order never decides.
3. Otherwise the normalised URL, unchanged. A plain feed URL is never
   rewritten beyond today's rule.

It is called in three places, and every test registry goes through the
existing `plugins` option:

- `resolveTarget` in `lib/reader.ts`, for both `{ url }` and `{ source }`
  (a built-in URL is canonical, so it passes through);
- the discovery `choices` in `subscribe`, instead of the bare
  `normaliseUrl`;
- the single discovered URL in `subscribe`.

Two spellings of one trending page therefore reach the same row, and the
second subscriber triggers no fetch.

`Feed.url` is the canonical URL, which serves as the configuration: no
config column and no migration (state §1). Canonical forms are **frozen
once shipped**. Changing one later is a migration that rewrites
`Feed.url` and merges duplicates.

### 4.2 `SourcePlugin`

```ts
// sources/types.ts
export interface SourcePlugin {
  id: string // stored on Feed.pluginId; never renamed without a migration
  // Pure, no I/O: the stored URL for an address this plugin owns, else null.
  canonical(url: URL): string | null
  // The title of a new feed; a built-in source's title wins.
  title?(url: string): string
  fetchEntries(ctx: {
    url: string // the stored, canonical Feed.url; plugins parse it
    fetch: SafeFetch
    known(urls: string[]): Promise<Set<string>>
    deadline: AbortSignal
  }): Promise<IngestedEntry[]>
}

// sources/index.ts
export function pluginFor(
  url: string,
  registry = plugins
): { plugin: SourcePlugin; url: string } | undefined // own keys only
```

This chooses `ctx.url` over a generic config object (critic 2: one
mechanism, not both). The parameterised plugin parses its own URL; fixed
plugins ignore it. `matches` goes, and `cursor-blog` becomes
`canonical: (u) => (u.href === LIST_URL ? LIST_URL : null)`, exact as
today.

What changes around it:

- **`fetchForAdd(url)`** calls `pluginFor(url)`, then
  `fetchEntries({ url, … })` under today's 40 s deadline and today's error
  mapping.
  - The title is the built-in title, else `plugin.title?.(url)`, else
    null. `siteUrl` is the canonical URL.
  - **The zero-entries rule stays**: a plugin returning `[]` at add is
    `not_found`. State's proposal to subscribe empty is rejected
    (critic 4).
- **`refreshFeed`** finds the plugin by `pluginId`, as today.
  - If `plugin.canonical(new URL(feed.url)) !== feed.url` (a shape removed
    or narrowed), it fails with today's "the source isn’t supported any
    more".
  - Otherwise it calls `fetchEntries` with `url: feed.url`. Everything else
    is unchanged.
- **`subscribe`** canonicalises through §4.1.
  - A `pluginId: null` row whose URL a new plugin would match keeps
    fetching as a feed, because refresh follows `pluginId`, not
    `pluginFor`.
  - No stored row matches a new plugin's canonical URL today: the new
    sites answered `not_found` until now.

### 4.3 Canonical forms

| Plugin | Canonical URL | Spellings accepted (anything else → null) |
| --- | --- | --- |
| `github-trending` | `https://github.com/trending[/{lang}]?since={daily\|weekly\|monthly}[&spoken_language_code={code}]` | http; `www.github.com`; trailing slash; a missing `since` (= daily); an empty `spoken_language_code` (dropped); other params dropped; `lang` lowercased and percent-encoded as GitHub writes it (`c%2B%2B`). A `since` outside the three values → null. `/trending/developers` → null |
| `anthropic-engineering` | `https://www.anthropic.com/engineering` | with or without `www`; trailing slash |
| `anthropic-news` | `https://www.anthropic.com/news` | with or without `www`; trailing slash |
| `bytes` | `https://bytes.dev/archives` | with or without `www`; trailing slash |
| `firefox-releases` | `https://www.firefox.com/en-US/releases/` | without trailing slash; `www.mozilla.org` and `mozilla.org` `/en-US/firefox/releases[/]` (which redirect there) |
| `cursor-blog` | `https://cursor.com/blog` | exact, as today |

## 5. The sources

### 5.1 Native feeds

Both are plain built-in sources, with no code beyond `builtinSources`.

| Source | What it serves | Notes |
| --- | --- | --- |
| `nodejs-blog` | 1,065 items, 325 KB | No validators, so each hourly poll is a full download, well under 10 MB. The newest 100 are taken. The guid carries the publish time and is stable while the date is. |
| `langchain-blog` | 100 items, 79 KB | Summary only. A conditional GET still answered 200. |

### 5.2 `github-trending`

One GET of `ctx.url` per refresh, with no per-repo fetches. Rows are
`article.Box-row`, and fields are read through Primer classes and
`itemprop`, not build hashes (ingest §3.3). The guid is
`https://github.com/{owner}/{repo}`, lowercased: **a repo appears once
ever**, matching rsshub's link-as-id (owner Q2). It can return only after
pruning, many months later. robots.txt allows `/trending` (checked
2026-10-22).

| The page shows | At add | On refresh |
| --- | --- | --- |
| zero rows and `.blankslate` (a verified empty list) | `not_found` (the guard in §4.2; usually a mistyped language) | success, nothing stored |
| zero rows and no `.blankslate` | the plugin throws "the page layout changed" | the same |
| a non-2xx answer | `SourceStatusError` | `SourceStatusError` |

### 5.3 List-and-posts plugins: one shared helper (critics 4–6, 8)

`sources/list-posts.ts` holds the algorithm `cursor-blog` has today, and
`cursor-blog` moves onto it (unit 3):

```ts
fetchListThenPosts(ctx, {
  listUrl,
  links($, pageUrl): Post[],                       // document order, deduplicated
  readPost(html, post): IngestedEntry | null,      // null = not a post page
})
```

- **Bounded history.** Only the first **30** list links are candidates.
  Unknown ones are taken in document order, at most 10 per run and 4 at
  a time. A new feed backfills its newest 30 over three runs and never
  reaches the archive. Bytes (531 issues) and Firefox (806 links) are
  therefore never re-fetched past retention: 30 is far below the 500 kept.
- **Starvation is bounded.** Lists are newest first, so new posts are
  always taken before older ones that keep failing. A post that keeps
  failing costs one slot per run, forever. Accepted.
- **When every post fails.** If there were unknown candidates and not one
  post could be read (a fetch error, a non-2xx answer, or `readPost`
  returning null), the helper throws "none of the new posts could be
  read". At add that is `not_found`; on refresh it is a failure with
  backoff, not a false success that resets `failureCount`. This is a
  deliberate narrowing for `cursor-blog` too, and it is tested.
  - Partial success is success.
  - No unknown candidates (all known) is success with `[]` on refresh.
- **Deadline.** Every request carries `ctx.deadline`, and a worker checks
  `deadline.aborted` before starting another post. On abort the helper
  stops and returns what it has. If that is nothing, the all-failed rule
  applies, and a `SafeFetchError` from the abort keeps its timeout text.
  - The 40 s plugin deadline leaves 20 s of the consumer's 60 s for
    parsing and the store transaction.
  - A run makes at most 11 requests. Each is capped by safe-fetch at
    10 MB; the measured pages are 12–64 KB. Posts are parsed one by one
    as they arrive, at most four at once.
- **A missing body is a summary-only entry, not a failure.** `readPost`
  returns an entry without content when the body selector misses, so a
  template change degrades the feed instead of stopping it. Under first
  version wins, a later selector fix does not repair stored entries.
  Accepted, and named in each plugin's test.

Per site (selectors from ingest §2, measured 2026-10-22). The guid is the
post URL without query or hash, as in `cursor-blog`.

| Plugin | Links | Post fields |
| --- | --- | --- |
| `anthropic-engineering` | every `article`'s `h3 a[href]`, same origin (posts now live under `/research/`) | title `og:title`; summary the meta description; date `article:published_time`, else the list `time` text, else null; body the parent of the first `p.post-text` |
| `anthropic-news` | `a[href]` whose class contains `title-link` or `tileLink`, same origin (root launch pages are kept) | the same fields; a launch page has no published time and takes the list tile's date. **The most fragile selector**: it leans on the component half of CSS-module class names |
| `bytes` | `a[href^="/archives/"]` with a numeric last segment | title `og:title`; summary the meta description; date the card's exact `MM/DD/YYYY` (UTC midnight), anything else null; body the parent of the first `p` starting "Today’s issue" |
| `firefox-releases` | `/firefox/{v}/releasenotes/` where `v` matches `^\d+\.0(\.\d+)?$` (no ESR) | title `Firefox {v}`; date `.c-release-date`; content `.c-release-notes` |

## 6. Refresh, cost and limits

- **Every feed is polled hourly**, as today. No per-plugin interval and no
  shared rate-limit state (state §5). Each new source costs one GET an
  hour, plus up to 10 post pages when a list has new posts.
- **github.com has no published limit** for unauthenticated HTML. GitHub's
  undocumented secondary limits may hit Vercel's shared egress IPs, which
  cannot be measured locally.
  - A 429 or 503 honours `Retry-After`, as today.
  - **A 403 does not** (critic 9): `answered()` reads `Retry-After` only
    for 429 and 503. A 403 takes ordinary backoff and is `failing` after
    3. This is unchanged and documented; the owner sees it in Admin first.
- Cron, queue, fan-out and the consumer are unchanged.

## 7. Schema, auth, API keys, local stack, env

No schema change, no migration, no env variable and no new dependency
(`cheerio` is already there). Auth and API keys are untouched. The local
stack is unchanged, and `scripts/refresh.ts` refreshes the new feeds
inline.

## 8. Failure cases

| Case | What happens |
| --- | --- |
| Trending URL with a bad `since`, or `/trending/developers` | not a plugin URL: the plain path finds no feed → `not_found` |
| Trending: unknown language or empty period | blankslate → `not_found` at add, empty success on refresh |
| Trending or list markup changed | "the page layout changed", `failing` after 3 |
| Post template changed | summary-only entries; noticed by reading |
| Every new post unreadable | "none of the new posts could be read", with backoff |
| Plugin deadline reached | stops starting posts: partial success, or the timeout text if nothing was read |
| A shape removed or narrowed in code | "the source isn’t supported any more"; entries kept |
| github.com limits Vercel's IPs | 429/503 honour `Retry-After`; a 403 takes ordinary backoff |
| hacks.mozilla.org, Codrops pasted | 403 → `unreachable` at add; out of reach (§11.4) |
| Large feed (nodejs 325 KB) | under 10 MB; the newest 100 are taken |
| Redirects (mozilla.org → firefox.com, LangChain domains) | the stored URL is the final one, so there is no redirect per poll |
| DB error in `known()` or the store | throws for redelivery, as today |

## 9. Test plan

As v1: `bun run test` against local `rssify_test`, run serially. **No test
reaches github.com, anthropic.com, bytes.dev, firefox.com, nodejs.org or
langchain.com.** Fakes go through the existing `fetch: SafeFetch` and
`plugins` seams and record each `(url, options)`.

**Fixtures** under `test/fixtures/<source>/` are synthetic, hand-written
with invented content and example domains, keeping only the structure the
code reads. Retain plugin canonical hosts only where a test needs them;
never save live pages. Each README is one line saying it is synthetic.
Cover these structures:

| Source | Pages |
| --- | --- |
| trending | JavaScript monthly; a blankslate page; one row without a language |
| Anthropic engineering | the list and two posts |
| Anthropic news | the list, a `/news/` post, a root launch page and a `/features/…` page |
| Bytes | the archive and two issues of different templates (#531, #400) |
| Firefox | the list, a major release and a dot release |

A passing fixture cannot detect a later change on the live site; that is
what the failing marker is for.

| Area | Cases |
| --- | --- |
| `canonicalUrl` | every spelling in §4.3 → its canonical URL; idempotent (`f(f(x)) = f(x)`); every canonical URL matches exactly one plugin; a bad `since`, `/trending/developers`, `github.com.evil.invalid` and other hosts → unchanged; plain feed URLs unchanged; each built-in `url` is its own canonical form; `pluginFor` ignores prototype names |
| `subscribe` | two trending spellings → one `Feed` row, and the second makes no fetch call; concurrent adds of two spellings → one row, both subscribed; discovery choices canonicalised; each new `{ source }`; `nodejs.org/en/blog` reaches the built-in row |
| `fetchForAdd` | plugin title, with the built-in title winning; `siteUrl` canonical; `[]` → `not_found` (the guard is kept) |
| `refreshFeed` | `ctx.url` = `Feed.url`; a row whose URL the plugin no longer canonicalises to itself → unknown source; today's `cursor-blog` row still refreshes |
| `list-posts` | an empty list → layout changed; all known → `[]`; partial success; all posts 404 → "none of the new posts could be read" on add and on refresh (failureCount rises); deadline during the list and during posts, with fake timers rather than a real 40 s → no new requests start; only the first 30 links considered (a 531-link fixture); a post that keeps failing does not block a newer one; a DB error in `known()` throws |
| `github-trending` | rows → entries with the guid as the lowercased repo URL and `publishedAt` null; content escaped; blankslate → `[]`; neither → layout changed; non-2xx → `SourceStatusError`; the title built from the URL per §2.2 |
| each site plugin | list fixture → the expected URLs in order; post fixture → the expected title, date and body coverage (first and last paragraph present, nav and footer absent); a missing body → a summary-only entry. News: a launch page takes the list date; topic links are excluded. Bytes: `10/20/2026` → 2026-10-20, a malformed date → null. Firefox: ESR excluded; `158.0` and `158.0.1` both kept |
| 403 | refresh with a 403 and `Retry-After` takes ordinary backoff (documents today's rule) |

**By hand**, at the end of each unit, on a local dev server on its own
port:

1. Add the unit's sources; check the title, the entries and Open website.
2. Run `scripts/refresh.ts` twice and check that nothing duplicates.
3. Stop the dev server.

## 10. Build units, in order

Each unit is one ship run with its tests, and updates `AGENTS.md` for what
it changes.

1. **Target contract and plugin interface.**
   - `lib/ingest/target.ts`; `SourcePlugin.canonical`, `title` and
     `ctx.url`; `pluginFor` returning `{ plugin, url }`.
   - `resolveTarget` and the discovery path call `canonicalUrl`.
   - `refreshFeed` gets the canonical guard and passes `url`;
     `fetchForAdd` uses `plugin.title`.
   - `cursor-blog` moves onto `canonical`, with its behaviour unchanged
     and its tests kept.
2. **Native built-ins.** `nodejs-blog` and `langchain-blog` in
   `builtinSources`, the scrolling source list, and the dialog screen checks.
3. **The list-and-posts helper.** `sources/list-posts.ts` with the
   30-link bound, stop-on-abort and the all-failed rule. `cursor-blog`
   moves onto it, with the deliberate all-failed change tested.
4. **`github-trending`.** The plugin, its canonical form and title, the
   dialog description clause and the MCP `subscribe` hint.
5. **Anthropic.** `anthropic-engineering` and `anthropic-news`, sharing
   one post reader, with their built-in entries.
6. **Bytes.** The plugin and its built-in entry.
7. **Firefox release notes.** The plugin and its built-in entry.

Units 2, 3 and 4 depend only on 1. Units 5–7 depend on 1 and 3.

## 11. Decisions, with the options considered

1. **Where the configuration lives.**
   - (a) The canonical URL in `Feed.url`.
   - (b) A JSON config column with its own uniqueness and a migration.

   **(a)**: the URL already is the identity, the dedup key and what the
   API shows.
2. **How a plugin learns its configuration.**
   - (a) `ctx.url`, parsed inside the plugin.
   - (b) A generic `parse(url): C` and `fetchEntries(config)`.

   **(a)**: one parameterised plugin does not justify generics.
3. **Empty results at add.**
   - (a) Keep "`[]` is `not_found`".
   - (b) Subscribe empty.

   **(a)**: the only empty-but-real case left is a blankslate trending
   page, which is usually a mistyped language. (b) also turned "every
   post failed" into a successful add.
4. **The 403 sites.**
   - (a) Change no headers and call them out of reach.
   - (b) A browser-like UA.
   - (c) Per-host header tweaks.

   Every variant tried was refused, on every path: our UA and others
   including a Firefox UA, HTTP/1.1 and 2, from curl, undici and Deno, on
   two networks. The cause is unknown (a TLS/HTTP fingerprint or IP
   reputation are plausible but not shown), and so is how Vercel's egress
   fares (critic 10). **(a)**, as the owner confirmed: no change was shown
   to help, and rssify does not impersonate a browser.
5. **A trending repo that recurs.**
   - (a) The repo URL as guid, so a repo is shown once.
   - (b) Repo plus period, so the whole list returns each period.

   **(a)**, as the owner chose (it is what rsshub did).
6. **Trending details.**
   - (a) From the trending HTML row.
   - (b) GraphQL with a token, as rsshub does.

   **(a)**: every field rsshub showed is in the row.
7. **Trending titles.**
   - (a) Slugs as GitHub writes them.
   - (b) Display names from the page, which needs a metadata return path.
   - (c) A casing table.

   **(a)**: the difference is cosmetic.
8. **History for list plugins.**
   - (a) Only the first 30 links.
   - (b) The whole list over many runs (Bytes 531, Firefox 806),
     re-fetching what retention prunes.

   **(a)**.
9. **An unusable trending URL.**
   - (a) Not a plugin URL, so it reads as `not_found`.
   - (b) A new `unsupported` code and sentence.

   **(a)**: with discussions gone, a code for one rare typo is not worth
   adding.
10. **Discussions.** Measured (GitHub Atom, REST, GraphQL) and then
    dropped by the owner. The analysis stays in ingest §3.1–§3.2 for a
    later task.

## 12. Critic findings and how each was resolved

The critic reviewed the drafts before the owner's answers. Findings about
discussions became moot when the owner dropped them.

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | Filtered discussions silently become all states (blocker) | Moot: discussions dropped (Q1) |
| 2 | No single target contract | Accepted, §4.1; `ctx.url` chosen over a config object |
| 3 | "Each also works pasted" is false | Accepted: per-plugin spellings in §4.3; the promise narrowed in §2.1; LangChain's page stays `not_found` |
| 4 | Three empty-trending outcomes, and a global empty rule | Accepted: the guard is kept; blankslate vs layout in §5.2; all-failed is a failure (§5.3) |
| 5 | The deadline doesn't bound the run | Accepted: stop-on-abort, 20 s reserved, per-run cost named (§5.3) |
| 6 | Starvation and re-fetching pruned history | Accepted: only the first 30 links; starvation bounded and accepted (§5.3) |
| 7 | Atom is 25 by activity, not 100 by creation | Moot: discussions dropped |
| 8 | Body selectors unproven | Accepted: synthetic, hand-written fixtures with invented content and example domains, a body-coverage assertion, and a missing body is summary-only (§5.3, §9) |
| 9 | 403 doesn't honour `Retry-After` | Accepted: today's rule documented and tested, not changed |
| 10 | The 403 cause is overstated | Accepted: reworded in §11.4 |
| 11 | Rank order is not preserved | Accepted: no rank promise |
| 12 | No return path for display names | Accepted: slug titles |

No finding was rejected, and none was sent back to an architect: each
resolution narrows scope, and the drafts stay as the record.

## 13. Owner's answers (2026-10-22)

- **Q1. Discussions.** Not needed for now. Dropped entirely: no paste
  rule, no token, and the Angular RFCs feed stays out.
- **Q2. Trending.** As rsshub does it: title `owner/name`, the repo URL as
  link and id (shown once ever), and a description with stats. rssify
  takes the details from the trending HTML and needs no token.
- **Q3. Codrops.** Left out; no Feedburner mirror.
- **Q4. hacks.mozilla.org and Codrops.** Out of reach, with no browser
  impersonation and no header change.

No new env variable.
