# RSSF-22 interface draft: adding GitHub pages and the named sites

Interface architect's answers to the brief's four Interface questions.
The short version: no new screen, form, key or setting. The Add a feed
dialog keeps its one field and grows its built-in list; the add path
gains four error codes with their sentences; plugin feeds get a title
at add time; GitHub entries are shaped so the existing list row and
entry page read well. Everything else (Settings, Admin, keys, `/api/v1`,
MCP) stays as built, apart from one MCP description string.

Where this draft depends on what ingest measures (`drafts/ingest.md`,
not landed when this was written) or on state's plugin interface
(`drafts/state.md`), it says so and gives the rule, not a guess.

## 1. How a person adds each kind

### 1.1 GitHub: paste the URL

The same URL field. A person copies the address from the browser:

| Pasted | Becomes |
| --- | --- |
| `https://github.com/angular/angular/discussions` | all discussions of the repo |
| `…/discussions/categories/rfcs` | one category |
| `…/discussions/categories/rfcs?discussions_q=is:open` (and the `discussions_q=is:open category:RFCs` form GitHub writes when you filter the list) | one category, one state |
| `https://github.com/trending/javascript?since=monthly` | trending, one language, one period |
| `https://github.com/trending?since=weekly` | trending, any language |

Which query terms are read (`is:open`, `is:closed`, `is:answered`,
`is:unanswered`, `category:`; trending's `since` and
`spoken_language_code`) is ingest's call; this draft only needs the rule
that a URL of a supported shape with a filter rssify can't honour is
refused with `unsupported` (§2), never subscribed with the filter
silently dropped. A follower would otherwise get entries they filtered
out and no sign why.

Other GitHub addresses keep today's path: `…/releases`, `…/tags` and
`…/commits` pages announce their `.atom` feeds and discovery finds them;
a pasted `.atom` URL is a plain feed. Only a GitHub page that is neither
a plugin shape nor a page with a feed gets the GitHub sentence
(`unsupported`) instead of the generic `not_found`, so the person learns
what does work.

The dialog's description gains one clause so the person knows GitHub
pages work at all:

> Paste a feed URL or a website’s address. We’ll find its feed. GitHub
> Discussions and Trending pages work too.

Placeholder stays `https://example.com`. No new field, no picker for
language, period or category: GitHub's own page is the picker, and its
URL is the configuration.

### 1.2 The named sites: built-in list entries

Six new entries, one per named site, beside the two that exist. Each
one also works pasted as a URL (a feed URL is a plain feed; a plugin's
list page matches the plugin). Ids are stable once shipped (they are
the `{ source }` API surface).

| id | title | note, if the site has a feed | note, if it needs a plugin |
| --- | --- | --- | --- |
| `anthropic-engineering` | Anthropic engineering | anthropic.com/engineering — its own feed | anthropic.com/engineering — no feed of its own |
| `anthropic-news` | Anthropic news | anthropic.com/news — its own feed | anthropic.com/news — no feed of its own |
| `bytes` | Bytes | bytes.dev — the newsletter’s own feed | bytes.dev — no feed of its own |
| `firefox-releases` | Firefox release notes | Desktop release notes — Mozilla’s own feed | mozilla.org — desktop release notes, no feed of their own |
| `langchain-blog` | LangChain blog | The LangChain blog’s own feed | The LangChain blog — no feed of its own |
| `nodejs-blog` | Node.js blog | nodejs.org — the Node.js blog’s own feed | nodejs.org/en/blog — no feed of its own |

Pick the column from ingest's measurement per site. The pattern is the
one O1 set: host (and path when the host alone is ambiguous), an em
dash, and whether rssify reads a real feed or the page. The title is
also the feed's sidebar title (`fetchForAdd` takes a plugin feed's
title from `builtinSources`; a plain feed keeps its own title from the
feed, as Claude Code does today).

Titles are sentence case, as the style asks. Order: alphabetical by
title, so the existing two stay findable and new
ones slot in without a debate: Anthropic engineering, Anthropic news,
Bytes, Claude Code blog, Cursor blog, Firefox release notes, LangChain
blog, Node.js blog. Each keeps the `RssIcon`.

hacks.mozilla.org and tympanus.net (Codrops) are not built-in sources:
they have real feeds and are pasted. If ingest finds them out of reach
from Vercel, the failure they show is the usual `unreachable` /
`lastError` "the site answered 403 Forbidden", which is true.

Nor are GitHub pages built-in sources: they are parameterised, and a
fixed "Angular RFCs" item would be the owner's OPML, not a source for
everyone.

**The dialog must scroll.** Eight `Item`s (~58 px each with gaps) plus
the header and field run past a 667 px phone and close to a laptop's
short viewport; the popup is `fixed`, centred and has no overflow rule,
so the list would be cut off. Use shadcn's scrollable-dialog pattern as
it comes: the `ItemGroup` of sources gets `max-h-[50vh] overflow-y-auto`
(with the `-mx-4 px-4` the example uses so focus rings aren't clipped).
The URL field stays at the top, always visible. No other layout change.

### 1.3 Sidebar titles

A plugin feed has no feed document to take a title from, and the list
shows `(untitled)` for a null title under All feeds, so every plugin
feed needs a title when it is added. Built-in sources have theirs; a
GitHub feed gets one from its URL and what the first fetch learnt:

| URL | Sidebar title |
| --- | --- |
| `github.com/angular/angular/discussions` | angular/angular · Discussions |
| `…/discussions/categories/rfcs` | angular/angular · RFCs discussions |
| `…/categories/rfcs?discussions_q=is:open` | angular/angular · Open RFCs discussions |
| `…/discussions?discussions_q=is:answered` | angular/angular · Answered discussions |
| `github.com/trending/javascript?since=monthly` | GitHub trending · JavaScript · this month |
| `github.com/trending/typescript?since=weekly` | GitHub trending · TypeScript · this week |
| `github.com/trending` (daily is GitHub's default) | GitHub trending · today |
| with `spoken_language_code=zh` | GitHub trending · JavaScript · today · in Chinese |

Rules:

- Owner and repo as GitHub spells them in the canonical URL (state's
  canonicalisation decides the case); a category by its display name
  from GitHub ("RFCs"), falling back to the slug; a language by GitHub's
  display name ("C++", "JavaScript"), falling back to the slug. The
  state word is GitHub's own (Open, Closed, Answered, Unanswered).
- Trending feeds lead with "GitHub trending" so they sort together in
  the sidebar (it sorts by title); discussions lead with `owner/repo` so
  a repo's discussions sit with nothing else of GitHub's in between.
- The title is set once, at add, like every plugin feed's today
  (refresh never changes a plugin feed's title). Where the plugin hands
  it back (a `title` beside `entries`, or a pure function of the URL) is
  state's interface call; the interface only needs a non-null title.
- `siteUrl` is the canonical GitHub URL, so the feed menu's Open website
  opens the same filtered page the person pasted.
- The toast says it as today: "Subscribed to angular/angular · RFCs
  discussions."

## 2. The sentences

### 2.1 At add (the dialog, `/api/v1` 422 `message`, MCP `isError`)

`fetchForAdd` collapses every plugin failure to `not_found` today
(only fetch errors and list-page statuses keep a code). That is right
for scrapers, but GitHub's failures have causes a person can act on
differently, so four codes join `AddErrorCode` and `addFeedError`.
They flow to `/api/v1` and MCP unchanged through `subscribeErrorBody`.

| Code | When | Sentence |
| --- | --- | --- |
| `unsupported` | a github.com address that is not a plugin shape and has no feed, or a plugin shape with a filter rssify can't read | "rssify can’t follow that GitHub page. It follows Discussions and Trending pages; for releases, tags and commits, paste the page and we’ll find its feed." |
| `not_found`, github.com discussions URL | GitHub answers 404: the repo is private, renamed or missing (the API can't tell them apart) | "We couldn’t find {owner}/{repo} on GitHub. rssify can only read public repositories." |
| `no_discussions` | the repo exists, Discussions are off; or the category doesn't exist | repo: "{owner}/{repo} doesn’t use GitHub Discussions." · category: "{owner}/{repo} has no “{category}” discussion category." |
| `no_token` | a shape that needs the GitHub API and no token is configured | "This rssify can’t read GitHub Discussions yet: it needs a GitHub token. Ask whoever runs it to add one." |
| `rate_limited` | GitHub's primary or secondary rate limit (403/429 with `x-ratelimit-remaining: 0` or `retry-after`) | "GitHub is limiting rssify’s requests right now. Try again in a while." |

Notes:

- `{owner}/{repo}` and `{category}` are parsed from what the person
  typed by `addFeedError`, the same way `{host}` is today (the file is
  client-side too; a small URL parse, no database). `no_discussions`
  could be two codes; one code with the category branch decided by
  whether the typed path has `/categories/` keeps the code list short.
- `no_token` exists only if the owner decides discussions need a token
  and none may be configured (ingest's measurement, the lead's owner
  question). If the owner makes the token required at deploy, or ingest
  reads discussions without one, drop the code. Its sentence names no
  env variable to a person who can't set it; the admin knows the name
  from AGENTS.md.
- A rate limit at add is not `unreachable`: "We couldn’t reach
  github.com" would be false and send the person checking the address.
- No time in the rate-limit sentence: the reset can be minutes or an
  hour, and the add path doesn't carry headers to the client.
- An empty discussion category (a new RFC category with nothing in it)
  should subscribe and show **No entries yet**, not fail: zero entries
  from an API is an honest answer, unlike a scraper that found nothing.
  That changes the "zero entries is `not_found`" rule for API-backed
  plugins only; flagged for state/ingest. Trending with zero repos stays
  a failure (it means the page changed).

### 2.2 On refresh (`lastError`, shown as "The last try failed: {lastError}.")

Lower case, no full stop, as the existing texts. They appear on the
feed's **This feed isn’t updating** alert and in Admin's Last error.

| Cause | `lastError` |
| --- | --- |
| no token configured | "GitHub needs a token to read discussions, and none is set" |
| rate limited | "GitHub limited our requests" |
| repo now private, renamed or deleted (404) | "the repository is private or no longer exists" |
| Discussions turned off | "the repository turned off discussions" |
| category removed | "the discussion category no longer exists" |
| trending page shows no repositories | "the page layout changed" (existing) |
| shape no longer supported after a code change | "the source isn’t supported any more" (existing) |

A rate-limited refresh should back off to GitHub's reset (as 429/503
honour `Retry-After` today) and not count towards `failing`? That is
state's and ingest's call; the interface only asks that a feed that
is merely waiting for GitHub's reset doesn't show **This feed isn’t
updating** after one hour. If it counts as a failure, the sentence above
is still true.

A repo GitHub renames answers with a redirect to the new name; if
ingest follows it, nothing shows; the title keeps the old name (titles
never change on refresh). Acceptable; noted for the owner only if
ingest finds renames common.

## 3. How GitHub entries read

The list row is: feed title (under All feeds) · time, then `title` in
bold, then `summary` (plain, ≤ 300 code points, clamped by the row).
The entry page is: title, a meta line (feed title · date · author),
`contentHtml` (sanitised) or the summary, Open original. GitHub entries
fill those fields; no new component.

### 3.1 A discussion

| Field | Value |
| --- | --- |
| `title` | the discussion title, as is ("RFC: Signal-based components") |
| `summary` | `plainText(body)` cut to 300 code points |
| `contentHtml` | GitHub's rendered `bodyHTML`, through `sanitizeContent` with the discussion URL as base |
| `author` | the author's login ("alxhub"); a deleted account is null (GitHub shows "ghost") |
| `publishedAt` | `createdAt` |
| `url` | the discussion's `html_url`; Open original goes there for comments and replies |

List row (a feed open): **RFC: Signal-based components** / "Over the
last year we’ve been working on…". Under All feeds the row's first line
reads "angular/angular · RFCs discussions · 3 h".

Entry page meta: "angular/angular · RFCs discussions · 12 October 2026 ·
alxhub".

What isn't shown: comment count, answered state, labels, reactions.
They change after the first fetch and "first version wins" would freeze
them wrong (state's guid answer). The opening post is what was
published; the thread lives on GitHub behind Open original. If state
decides an edited discussion re-stores (not first-version-wins), the
fields above still hold.

For an "all discussions" feed the category isn't in the row; the person
chose the whole repo. Adding it as a `content` prefix would also land in
the summary and repeat on every row of a one-category feed. Leave it out.

### 3.2 A trending repository

| Field | Value |
| --- | --- |
| `title` | `owner/name` ("vercel/next.js") |
| `summary` | the repo description, plain; null if it has none |
| `contentHtml` | see below |
| `author` | null (the owner is already in the title) |
| `publishedAt` | null, so `sortAt` is the time rssify first saw it on the page |
| `url` | `https://github.com/owner/name` |

`contentHtml`, built by the plugin from the trending page's fields and
then sanitised like any content:

```html
<p>{description}</p>
<p>{language} · {stars} stars · {periodStars} stars this month</p>
```

("this week" / "today" by the feed's period; the language part is left
out when GitHub shows none; numbers as GitHub prints them, with their
commas). No README: one extra request per repo for a page that is one
click away behind Open original.

List row: **vercel/next.js** / "The React Framework". A repo without a
description is a one-line row, which the list already handles.

Entry page meta: "GitHub trending · JavaScript · this month · 22 October
2026". The date is when it was first seen trending; the stats line is
the snapshot from that moment. A repo trending again next month is the
same entry or a new one by state's guid decision; either way the row
reads the same.

### 3.3 The named sites

Plain feeds read as any feed. Plugin sites read as Cursor's: title,
meta description as summary, the article body as content, author when
the page names one.

## 4. Keys

None new. Every frequent action on these feeds is the existing one
(j/k, o/Enter, m, v, r, a, Shift+A), checked against the browser in the
v1 design §3; nothing here adds an action. The scrollable source list
in the dialog scrolls with the arrow keys and Tab like any overflow
container; `canHandleKey` already ignores keys while the dialog is open.

## 5. Settings, Admin, `/api/v1`, MCP

- **Settings**: no change. There are no per-user GitHub tokens
  (non-goal).
- **Admin**: no change. The Feeds table shows the GitHub URL, which
  wraps as URLs do, and `lastError` carries "GitHub needs a token…" for
  every GitHub feed when the token is missing, so the admin sees it. A
  line like Registration's ("GitHub token: set / not set") was
  considered and left out: it only repeats what the Feeds table already
  says, and it would be the first env readout besides registration.
  If the owner wants it, it is one sentence in the Registration card.
- **`/api/v1`**: no shape change. New built-in ids are accepted by
  `{ source }` (it is `z.string()` checked against `builtinSources`);
  new codes appear in the 422 body's `code` with the §2.1 sentences as
  `message`. Clients that switch on `code` should treat unknown codes as
  a failure, as AGENTS.md's error shape already implies.
- **MCP**: `subscribe`'s behaviour is the same; its description gains
  the GitHub hint so an agent knows to pass the page URL:
  "Follow a feed by its URL or a site's address (a GitHub Discussions or
  Trending page works too), or a built-in source by id. If a site has
  several feeds, the error lists them as choices; call again with one."
  `list_feeds` already returns `pluginId`, which for GitHub feeds is the
  family's id.

## 6. Server and client

Nothing moves. `add-feed.tsx` stays a client component (it holds the
dialog state, the pending button and the choices); the built-in list
still arrives as a promise from the server layout, so the eight entries
and their Subscribed badges cost no client fetch. `lib/add-feed-errors.ts`
stays importable from the client: its new `{owner}/{repo}` parse is a
`new URL` and a path split, no database. The list row and entry page
stay server components; GitHub content is server-sanitised HTML like
any other.

Check these states on a local dev server with seeded data:

- dialog with eight sources, desktop / phone (list scrolls) / dark.
- `unsupported`, `no_discussions`, `rate_limited` under the field.
- a discussions feed and a trending feed in the list.
- a discussion and a trending entry.
- a GitHub feed failing (no token).

## 7. Questions for the lead

1. Token required or optional is the owner's (the brief says so). The
   interface is ready for either: with a required token `no_token`
   disappears; with an optional one it stays as written.
2. "Zero entries from an API is a valid empty feed" (§2.1) changes a
   rule `fetchForAdd` has for all plugins; state/ingest to accept or
   refuse. If refused, an empty category reads as `not_found` with the
   GitHub sentence, which would be wrong ("couldn't find
   angular/angular") — then the plugin should return `no_discussions`
   with a third sentence: "{owner}/{repo}’s “{category}” category has
   no discussions yet."
