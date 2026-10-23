# RSSF-1 ingest draft: fetching, parsing and refreshing feeds

Ingest architect's answer to the brief's ingest questions 1–8, plus the shared
items. Plan: Vercel Pro (owner's answer). Feeds are shared rows across users'
subscriptions (state owns the model); a user-supplied URL is fetched by our
function.

Everything below was read or measured on **2026-10-21**. Captures were taken
locally into `/tmp` with a plain `fetch`/`curl` and are not committed (one file
per member); the excerpts quoted here are the record, and §9 lists the
structures synthetic test fixtures should model.

## Summary

- One function does all the work: `refreshFeed(feedId)`. The add-feed action,
  the queue consumer, a local script and the tests all call it. The queue is
  only a way to call it once per due feed on Vercel.
- Vercel Cron every 15 minutes → `GET /api/cron/refresh` claims due feeds in
  Postgres and `send`s one `@vercel/queue` message per feed → the consumer
  route calls `refreshFeed`. `vercel.json` is required (cron + queue trigger).
- RSS, Atom and RDF are parsed with `@rowanmanning/feed-parser`; JSON Feed is
  plain JSON mapped by us. HTML is sanitised once, at ingest, with
  `sanitize-html`.
- No headless browser. Both old sources render on the server. The Claude Code
  blog now publishes real RSS (`https://claude.dev/rss.xml`), so only Cursor
  needs a source plugin.
- Fetch hygiene: `undici` with a connector that rejects non-public IPs on
  every connection (covers redirects and DNS rebinding), 15 s timeout, 10 MB
  cap, at most 5 redirects, http/https on ports 80/443 only.

---

## 1. Vercel Queues and Cron config, today

### Queues: `vercel.json` is needed

The owner's belief does not hold today for Next.js:

- The JS SDK reference configures App Router consumers only through
  `functions.<route file>.experimentalTriggers` with
  `{ "type": "queue/v2beta", "topic": … }` in `vercel.json`
  (https://vercel.com/docs/queues/sdk, `last_updated: 2026-08-12`; same in
  https://vercel.com/docs/queues/quickstart, `last_updated: 2026-08-24`).
- The only framework integration on that page is **Nitro v3**
  (`nitro.config.ts` → `vercel.queues.triggers`). There is no Next.js one.
- The package agrees. `@vercel/queue@0.8.0` (npm `latest`, published
  2026-10-05) README §"Configure vercel.json": "Tell Vercel which routes handle
  which topics". In dev mode the SDK reads `vercel.json` from `process.cwd()`
  to find handlers (`dist/index.mjs` line 819). A `handleCallback` with no
  matching trigger logs "has no matching experimentalTriggers in vercel.json.
  This handler won't receive messages" (`dist/index.mjs` line 1012).
- Queues is **Beta on all plans** (https://vercel.com/docs/queues). The
  trigger type is `queue/v2beta` and the key is `experimentalTriggers`, so we
  should expect renames before GA.
- Trigger options (https://vercel.com/docs/queues/concepts, "Consumer function
  security"): `topic`, `retryAfterSeconds` (default 60), `initialDelaySeconds`,
  `maxDeliveries` (default unlimited). A consumer with a trigger has no public
  URL. Only Vercel's queue infrastructure can invoke it, so it needs no auth
  code.

### Cron: `vercel.json` `crons`; `@vercel/schedules` is not usable

- Vercel Cron is registered through `vercel.json` `crons` (or the Build
  Output API) (https://vercel.com/docs/cron-jobs). Vercel sends a `GET` to the
  production URL with UA `vercel-cron/1.0`. With `CRON_SECRET` set, it also
  sends `Authorization: Bearer <CRON_SECRET>`
  (https://vercel.com/docs/cron-jobs/manage-cron-jobs).
- Pro: minimum interval once per minute, invoked within the minute; 100 cron
  jobs per project; crons are included in all plans
  (https://vercel.com/docs/cron-jobs/usage-and-pricing).
- Vercel does not retry a failed cron invocation. Delivery is best effort and
  can be missed or **duplicated**. Crons do not follow redirects, and they do
  not run under `next dev` or `vercel dev`
  (https://vercel.com/docs/cron-jobs/manage-cron-jobs).
- `@vercel/schedules` exists but is not usable for v1. Its npm `latest` is
  `0.0.0`, an empty stub whose whole `index.js` is `export {};`. The real SDK
  is only under the `alpha` tag (`0.0.0-alpha.17`, published 2026-10-16). It
  creates schedules at runtime through an API (`Schedules.create({ target: {
  topic }, expression: { type: 'cron', … } })`) and authenticates with OIDC.
  It has no docs page (`https://vercel.com/docs/schedules.md` returns 404).
  Not GA, so not for v1.

### `vercel.json`, whole and minimal

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [{ "path": "/api/cron/refresh", "schedule": "*/15 * * * *" }],
  "functions": {
    "app/api/queues/refresh-feed/route.ts": {
      "experimentalTriggers": [
        { "type": "queue/v2beta", "topic": "feed-refresh", "maxDeliveries": 3 }
      ]
    }
  }
}
```

- `maxDeliveries: 3` bounds the cost of a poisoned message. Each failed push
  delivery that times out is billed for the function's full `maxDuration`
  (concepts, "Cost of failed deliveries"). The default `retryAfterSeconds: 60`
  is kept.
- `maxDuration` goes in the route files as Next.js segment config
  (`export const maxDuration = 60`), not in `vercel.json`
  (https://vercel.com/docs/functions/configuring-functions/duration).
- If the app uses `src/`, the key becomes `src/app/api/queues/…`. The key
  must match the route file's path exactly.

## 2. Local and test runs without `vercel link`

What the SDK offers today (`@vercel/queue@0.8.0` README, "Local
Development"), and why neither option works without `vercel link`:

- **SDK-managed dev delivery.** With `NODE_ENV=development`, messages are
  sent to the real Vercel Queue Service and then handed in-process to
  handlers it finds through `vercel.json`. This still needs OIDC credentials
  from `vercel env pull`.
- **Local broker.** When `VERCEL_CLI_VERSION ≥ 59.26.0` injects
  `VERCEL_QUEUE_BASE_URL` and `VERCEL_QUEUE_TOKEN`, the SDK talks to a local
  broker. That is `vercel dev`, which wants a linked project.

So we do not run the queue locally. The seam is a plain function argument, so
there is no fake queue to maintain:

```ts
// lib/ingest/fan-out.ts
export async function fanOut(enqueue: (feedId: string) => Promise<void>) {
  const ids = await claimDueFeeds(); // §4
  await Promise.all(ids.map(enqueue)); // in chunks of 50
  return ids.length;
}

// app/api/cron/refresh/route.ts  (production)
//   checks CRON_SECRET, then: fanOut((id) => send('feed-refresh', { feedId: id }, { idempotencyKey: … }))

// app/api/queues/refresh-feed/route.ts  (production)
export const maxDuration = 60;
export const POST = handleCallback(async ({ feedId }: { feedId: string }) => {
  await refreshFeed(feedId);
});

// scripts/refresh.ts  (local: `bun scripts/refresh.ts`)
//   fanOut((id) => refreshFeed(id))   — same claim, same refresh, no queue
```

- **Local dev.** `bun scripts/refresh.ts` runs a whole cycle against the
  docker Postgres. Adding a feed in the UI already fetches it inline (§4), so
  a developer rarely needs the script.
- **Tests.** Unit and integration tests call `refreshFeed(feedId)` with a
  stubbed fetch that returns fixture bytes (§9), and `fanOut(spy)` to check
  what is claimed. No test imports `@vercel/queue` or sends anything.
  `handleCallback`'s acknowledge and retry behaviour is the SDK's and is not
  re-tested. State owns the runner and the test plan; this is the seam I ask
  for.

## 3. Cron frequency (Pro): every 15 minutes

The cron cadence only bounds the extra delay on top of each feed's own
interval (§4: 60 minutes by default). Messages are sent only for due feeds,
so the cadence does not change the number of queue messages. A tick that
finds nothing due costs one short invocation and one query.

| Cadence | Worst lag past the feed's interval | Cron invocations / month | Neon effect (see note) |
| --- | --- | --- | --- |
| `*/5`  | 5 min  | 8,640 | compute never idles 5 min → never suspends |
| `*/15` | 15 min | 2,880 | wakes ~4×/h, ~6 min each → awake ~40% |
| `0 *`  | 60 min | 720   | awake ~10% |

Cost per message on Pro, with docs prices:

- **Queue operations.** Messages are metered in 4 KiB chunks. A send with an
  idempotency key counts 2×. One message is about 4 operations (send ×2,
  notify, delete) (https://vercel.com/docs/queues/pricing). Operations cost
  $0.60–0.96 per million (https://vercel.com/docs/pricing/regional-pricing).
- **Function invocations.** $0.60 per million, plus Active CPU and
  provisioned memory (https://vercel.com/docs/functions/usage-and-pricing).
  A consumer spends most of its time waiting on the network, and Active CPU
  is not billed while it waits.
- **Worked example.** 500 feeds polled hourly ≈ 360k messages/month ≈ 1.44M
  queue operations ($0.9–1.4) plus 360k invocations (~$0.22) plus CPU and
  memory. Rounding error on Pro either way.

**Choice: `*/15`.** A feed is at most 15 minutes late. The real cost is not
Vercel but Neon:

- **Every 5 minutes** keeps a scale-to-zero compute awake around the clock:
  730 h × 0.25 CU ≈ 182 CU-hours/month, against 100 on Neon Free and
  $0.106/CU-hour on Launch (https://neon.com/docs/introduction/plans: Free
  suspends after 5 min idle, smallest compute 0.25 CU).
- **Every 15 minutes** is about 73 CU-hours by the same estimate, before any
  reader traffic.

This is an estimate, not a measurement, and is the state architect's to
confirm against the Neon plan. Hourly is the fallback if Neon cost matters
more than freshness.

A "refresh now" button would be nearly free: a server action that calls
`refreshFeed` for one feed, skipped if the feed was fetched less than a
minute ago. I suggest it to interface as optional; it is not needed on Pro.

## 4. What is "due", and the fan-out

### Fields ingest needs on the shared feed row

State owns the names and the schema. Ingest reads and writes these:

| Field | Meaning |
| --- | --- |
| `url` | the feed URL, or the site URL for a plugin feed (§6) |
| `plugin` | plugin id, or null for a real feed |
| `etag`, `lastModified` | validators from the last 200 response |
| `nextFetchAt` | when the feed is next due (null = stopped) |
| `lastFetchedAt` | last attempt |
| `lastSuccessAt` | last 200 or 304 |
| `failureCount` | consecutive failures |
| `lastError` | short text shown to the reader |
| `status` | `ok` \| `failing` \| `gone` |

### The rule: fixed interval, backoff on failure, nothing else

| Outcome of a fetch | Next `nextFetchAt` | Other writes |
| --- | --- | --- |
| 200 parsed, or 304 | now + 60 min | `failureCount = 0`, `status = ok`, store validators |
| 429 or 503 with `Retry-After` | now + max(backoff, Retry-After), capped 24 h | `failureCount++` |
| timeout, DNS error, 4xx, 5xx, too large, not a feed | now + backoff | `failureCount++`, `lastError`; `status = failing` once `failureCount ≥ 3` |
| 410 Gone | null (stopped) | `status = gone` |

- Backoff is `min(60 min × 2^failureCount, 24 h)`: 2 h, 4 h, 8 h, 16 h, then
  daily, for good. We never stop polling except on 410.
- No `ttl`, `sy:updatePeriod`, `Cache-Control` or adaptive intervals in v1.
  These are listed as later.
- Conditional GET is always on. We send `If-None-Match` and
  `If-Modified-Since` when we hold validators. Measured on 14 real feeds
  (§9):
  - 10 sent an `ETag` and/or `Last-Modified`, and 9 of those answered our
    conditional request with `304`.
  - `daringfireball.net/feeds/json` sent validators but answered `200`
    again.
  - 4 sent no validators: `news.ycombinator.com/rss`,
    `cursor.com/changelog/rss.xml`, `deno.com/feed` and NYT's RSS. Neither
    cursor blog page (list or post) sends one either.
  - So a 304 saves work when it comes, but the design must not depend on it.
    An unchanged 200 is cheap anyway: the upsert writes nothing new.

### Fan-out (the cron route)

1. Check `Authorization: Bearer ${CRON_SECRET}`; otherwise 401.
2. **Claim** in one statement. Roughly:
   ```sql
   UPDATE feed SET "nextFetchAt" = now() + interval '30 minutes'
   WHERE id IN (
     SELECT id FROM feed
     WHERE "nextFetchAt" <= now() AND <has at least one subscription>
     ORDER BY "nextFetchAt" LIMIT 500
     FOR UPDATE SKIP LOCKED)
   RETURNING id
   ```
   The 30-minute push is a lease. If the message is lost, or the consumer
   dies after its 3 deliveries, the feed simply comes due again. A duplicate
   cron run finds nothing left to claim, so the database is what
   de-duplicates ticks.
3. `send('feed-refresh', { feedId }, { idempotencyKey: \`${feedId}:${tick}\` })`
   for each claimed id, 50 at a time in parallel. `tick` is the run's start
   rounded down to 15 minutes. The key only covers a `send` that we retry
   within one run (dedup window `min(retention, 24h)`, SDK reference "Send
   options"). The SDK's `experimental_sendBatch` exists (`dist/index.d.mts`)
   but is undocumented and experimental, so we do not use it.
4. Many due feeds:
   - 500 per tick × 4 ticks/hour = 2,000 feeds/hour, enough for v1.
   - Overflow stays due and goes first next tick (ordered by
     `nextFetchAt`).
   - 500 sends finish well inside the default 300 s duration (Pro default
     300 s, maximum 800 s; https://vercel.com/docs/functions/limitations).
   - Raising the limit is a one-number change.

### Consumer (one message = one feed)

- `refreshFeed` records every source failure on the feed row (table above)
  and **returns normally**, so the message is acknowledged. Source backoff
  lives in Postgres, not in the queue.
- It throws only on our own failures (the database is unreachable). The
  queue then redelivers after 60 s, up to 3 deliveries.
- Duplicate deliveries are harmless. At-least-once delivery is documented
  (concepts, "At-least-once delivery"). Entries are upserted by their
  identity (§5), and a second run soon after usually gets a 304.
- What fits in one function (`maxDuration = 60`):
  - one feed fetch, at most 15 s;
  - parsing: the largest measured feed, 3.9 MB / 1,691 entries, parsed in
    86 ms;
  - an upsert of at most 100 entries;
  - for a plugin, up to 10 post pages, 4 at a time, at most 10 s each.

  Worst case is about 45 s.

## 5. Parsing

### Library: `@rowanmanning/feed-parser`; JSON Feed by hand

I ran three maintained parsers on 14 real feeds plus broken inputs (§9):

| | `@rowanmanning/feed-parser` 2.1.5 (2026-09-09) | `@extractus/feed-extractor` 8.0.3 (2026-08-06) | `feedsmith` 3.0.1 (2026-09-25) |
| --- | --- | --- | --- |
| RSS 2.0 / Atom / RDF | all parsed | all parsed | parsed |
| JSON Feed 1.0/1.1 | **no** ("could not be parsed as a feed") | yes | yes |
| One normalised item shape | yes (`id`, `url`, `title`, `content`, `description`, `published`, `updated`, `authors`, `categories`) | yes, but only `id, title, link, published, description` | no: per-format shapes, raw date strings |
| Entry HTML content | kept as HTML | **stripped to text**, truncated to 250 chars by default | kept |
| `xml:base` / relative links | resolved (`post-1` → `https://ex.com/blog/post-1`) | — | — |
| Item without guid (HN, Slashdot) | `id: null`, honest | invents an id (`vxoum0-1792610455000`) | absent |
| Bad date | `null` | — | raw string |
| Truncated XML | lenient: returned 8 of 16 RSS items; threw on truncated Atom | throws | throws |
| Deps | `fast-xml-parser`, `html-entities` | `fast-xml-parser` | `fast-xml-parser`, `entities` |

No library fits all of it. The options:

- **A (chosen).** `@rowanmanning/feed-parser` for XML. For JSON Feed (the
  body starts with `{`), `JSON.parse` and map `id`, `url`, `title`,
  `content_html ?? content_text`, `summary` and `date_published` (about 15
  lines; the format is already JSON). This keeps HTML content and gives the
  most honest output.
- **B.** `@extractus/feed-extractor` for everything. One library, but entry
  HTML has to be pulled back out through `getExtraEntryFields` per format,
  and it invents ids.
- **C.** `feedsmith` for everything. It covers all four formats, but we
  would write four mappings and parse dates ourselves.

### Bytes to text: we decode, not `response.text()`

`response.text()` always decodes as UTF-8. Measured cases:

- `opennet.ru/opennews/opennews_all.rss` declares
  `<?xml … encoding="koi8-r"?>` with no charset in `Content-Type`; decoded as
  UTF-8 it is mojibake.
- `rss.slashdot.org` declares `ISO-8859-1`.

The rule:

1. The charset from `Content-Type`.
2. Else a BOM.
3. Else the XML prolog `encoding=`.
4. Else UTF-8.

Then `new TextDecoder(charset)`; an unknown label falls back to UTF-8. The
HTTP header winning over the prolog follows RFC 7303.

### Normalised entry (what ingest hands to state)

```ts
interface IngestedEntry {
  guid: string;              // identity within the feed, see below
  url: string | null;        // absolute
  title: string;             // text; "" → first 80 chars of summary, else "(untitled)"
  author: string | null;
  publishedAt: Date | null;  // null when absent or unparseable; never "now"
  summary: string | null;    // plain text, ≤ 300 chars, for the list
  contentHtml: string | null;// sanitised (content ?? description), ≤ 200 KB, for the reader
}
```

Example from `https://claude.dev/rss.xml` (first item, 2026-10-21). This feed
has only `<description>` and no `content:encoded`, so both fields come from
it:

```json
{
  "guid": "https://claude.dev/blog/solving-code-review-at-anthropic/",
  "url": "https://claude.dev/blog/solving-code-review-at-anthropic/",
  "title": "How the Claude Code team does code review",
  "author": "Addy Osmani, Morgan Westlee Lunt, and Qing Wang",
  "publishedAt": "2026-10-15T12:00:00.000Z",
  "summary": "How do you review code at the volume agents produce it? On the Claude Code team, …",
  "contentHtml": "How do you review code at the volume agents produce it? On the Claude Code team, once we had high coverage and deep reviews, …"
}
```

### Identity and de-duplication

- `guid` is the first present of:
  - the parser's `id` (RSS `<guid>`, Atom `<id>`, JSON Feed `id`);
  - the absolute `url`;
  - `sha1(title + publishedAt)`.
- Measured: HN and Slashdot items have no guid, and their link is unique per
  item.
- Uniqueness is `(feedId, guid)`. A repeat is an update of title, summary,
  content and url. It never changes `publishedAt` once set, and never
  changes the first-seen time or anyone's read state. Hand-off to state.
- `publishedAt` null: the reader sorts by `publishedAt ?? firstSeenAt`. The
  old providers used `new Date()` for a missing date, which moved the entry
  on every scrape. We store null instead.
- Only the newest 100 entries of a fetch are upserted, by `publishedAt`, then
  document order. The Vercel changelog Atom has 1,691 entries (3.9 MB), and a
  first fetch should not insert them all. Retention is state's.
- Cross-feed duplicates (the same article in two feeds) are left alone in v1.

### Sanitising: once, at ingest, with `sanitize-html`

- **Where.** At ingest. Entries are shared across users and rendered many
  times, so cleaning once is cheaper. The reader renders the stored HTML
  as-is (`dangerouslySetInnerHTML`) and runs no sanitiser on the server
  component path.
- **Library.** `sanitize-html` 2.18.1 (2026-10-14; built on `htmlparser2`, no
  DOM). `isomorphic-dompurify` 4.6.0 pulls in `jsdom` 30, which is heavy for
  a cold start.
- **The parser does not sanitise.** Measured: `@rowanmanning/feed-parser`
  returns
  `<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:x">`
  untouched.
- **Allowlist.** Tags: `sanitize-html`'s defaults plus `img`, `figure`,
  `figcaption`, `picture`, `source`, `video` and `audio`. Attributes: `href`,
  `src`, `srcset`, `alt`, `title`, `width`, `height`. Schemes: `http`,
  `https` and `mailto` only. No `style`, no `on*`, no `iframe`.
- **Links.** `<a>` get `rel="noopener noreferrer nofollow"` and
  `target="_blank"`. Relative `href`/`src` are made absolute against the
  entry URL (`transformTags`).
- **Summary.** The same library with `allowedTags: []`, truncated to 300
  characters.
- **Not re-sanitised.** A changed allowlist applies to new and updated
  entries only. Accepted for v1.
- Images stay hot-linked (the reader's browser fetches them from the source).
  An image proxy is later.

### Feed discovery from a site URL

1. Fetch the URL with `Accept` preferring feeds.
2. If the body parses as a feed, it is the feed (store the final URL after
   redirects).
3. Else parse it as HTML (`cheerio` 1.2.0, the same parser the plugins use)
   and collect `<link rel~="alternate">` elements whose `type` is
   `application/rss+xml`, `application/atom+xml`, `application/feed+json` or
   `application/json`. Resolve each against the final URL.
4. If more than one is found, show the list; one is used as it is.
5. No guessing of `/feed`, `/rss.xml` and the like. If none is found: "No feed
   found at this address."

Measured on 12 real pages:

| Page | Result |
| --- | --- |
| `claude.dev/blog` | → `claude.dev/` → `https://claude.dev/rss.xml` |
| `simonwillison.net/` | `atom/everything/` |
| `daringfireball.net/` | Atom **and** JSON (same content) |
| `deno.com/blog` | `deno.com/feed` |
| `github.com/vercel/next.js/releases` | `releases.atom` and `tags.atom` |
| `news.ycombinator.com/` | `/rss` |
| `jsonfeed.org/` | three: `feed.xml`, `podcast.xml`, `feed.json` |
| `vercel.com/changelog`, `cursor.com/changelog`, `cursor.com/blog`, `claude.com/blog` | **none** (`vercel.com/atom` and `cursor.com/changelog/rss.xml` exist but are not linked) |
| `www.nytimes.com/` | **403** to our user agent |

Several sites therefore need the feed URL pasted directly, and the add-feed
error should say so.

### Add feed = discover + first fetch, inline

The add-feed server action:

1. If the URL matches a plugin's `siteUrl`, use the plugin (§6).
2. Else discover.
3. Then find or create the shared feed row by its final URL.
4. Call `refreshFeed` right away, so the reader sees entries at once and a
   bad URL fails at the form, not 15 minutes later.

This takes one fetch and one parse, about 1–2 s for typical feeds; the slowest
measured, `simonwillison.net/atom/everything/`, took 7 s. That is inside a
server action's default duration.

## 6. Source plugins for sites without a feed

### What I found with a plain fetch today

- **claude.com/blog: the old selectors are dead, and the Claude Code blog no
  longer needs scraping.**
  - `https://claude.com/blog` now answers 308 → `/resources/articles`, a
    Next.js page with CSS-module class names
    (`ResourceCard-module-scss-module__q33Tuq__card`).
  - `.blog_cms_item` matches **0** elements, and `.u-rich-text-blog` on a
    post matches **0**.
  - What still works without a browser:
    `[class*="ResourceCard-module"][class*="__card"]` finds 12 cards with
    href, title and date ("Oct 21, 2026"). They include duplicates (the
    featured "Introducing Claude Duet" appears twice) and links out to
    `claude.dev/blog/…` and `anthropic.com/engineering/…`.
  - On a post, `meta[name=description]`, `article:published_time` and
    `.text-rich-text--article` (4,320 chars) all work.
  - Most important: the Claude Code posts on that page link to
    `claude.dev/blog/…`, and `https://claude.dev/rss.xml` is real RSS 2.0.
    It has 16 items with guid, pubDate, `dc:creator` and category, sends an
    `ETag` and answers our conditional GET with `304`, and is linked from
    `claude.dev`'s `<head>`.
- **cursor.com/blog: still server-rendered; the selectors half work.**
  - There are 62 `<article>` elements in four shapes:
    - 28 `a.card` + `p.type-base` + `time`;
    - 24 rows where the `<a>` now **wraps** the `<article>`, so
      `article a.card` misses them;
    - 8 cards with no `time`;
    - 2 video cards with no `p.type-base` title.
  - 28 of the 62 link off-site (x.ai, youtu.be, techcrunch…). The old
    provider took those as posts.
  - The 34 `/blog/` links are only 15 unique posts.
  - Post pages work as before: `.prose--blog` (first of 2 identical matches;
    4.5–20 KB of text), `meta[name=description]`, `og:title` ("Git at any
    scale · Cursor"), `time[datetime]`.
  - `cursor.com/atom.xml` exists but stopped at 2024-11-11 (8 entries), and
    `cursor.com/rss.xml` is an HTML page, so a plugin is still needed.
- **Both sites returned 200 to an honest UA** (`rssify/1.0 (+repo URL)`) as
  well as to the old `Mozilla/5.0 (compatible; Rssify/1.0)`. claude.com sits
  behind Cloudflare, so a bot challenge is possible later; none today.

**A headless browser is not needed in v1.** Every list and post field above
is in the static HTML. That also removes the old `hasContent() < 200 chars →
Chromium` fallback. If a source someday renders only in a browser, the options
are not to support it, a hosted browser API (a new service, the owner's call),
or `@sparticuz/chromium` in a function (about 60 MB, slow cold start). None is
for v1.

### The plugin interface

```ts
// sources/types.ts
export interface SourcePlugin {
  id: string;        // stable, stored on the feed row: 'cursor-blog'
  title: string;     // 'Cursor Blog'
  siteUrl: string;   // 'https://cursor.com/blog' — also the feed row's url
  fetchEntries(ctx: {
    fetch: SafeFetch;                                  // §8, the only network access
    known(urls: string[]): Promise<Set<string>>;       // which posts this feed already has
  }): Promise<IngestedEntry[]>;                        // same shape as §5, pre-sanitise
}

// sources/index.ts
export const plugins: Record<string, SourcePlugin> = { [cursorBlog.id]: cursorBlog };
```

- **Registration.** A const map in code: adding a plugin is a code change and
  a deploy. A plugin feed row is `{ url: plugin.siteUrl, plugin: plugin.id }`,
  shared by everyone who subscribes.
- **Dispatch.** `refreshFeed` uses `plugins[feed.plugin].fetchEntries`
  instead of fetch+parse. Sanitising, upsert and backoff are the same path.
- **Built-in sources.** Rows seeded by the migration (state's call how). The
  add-feed form lists them, and pasting `https://cursor.com/blog` finds the
  plugin by `siteUrl`.
- **`known()`** replaces the old Redis per-post cache. Post pages are fetched
  only for links the feed does not have yet: at most 10 per run, 4 at a time.

### The two built-in sources

1. **claude-code → a plain feed**, `https://claude.dev/rss.xml`, no plugin.
   (Owner question O1: the old provider scraped the broader claude.com blog.)
2. **cursor → plugin `cursor-blog`:**
   - **List.** `GET https://cursor.com/blog`. For each `article`, the link is
     `article.closest('a') ?? article.querySelector('a')`. Keep only hrefs
     starting with `/blog/`, made absolute; de-duplicate by URL. The list
     date is `time[datetime]`.
   - **Post** (new URLs only):
     - title: `og:title` with the trailing " · Cursor" removed, else the
       list's first `p.type-base`, else `img[alt]`;
     - summary: `meta[name=description]`;
     - content: the first `.prose--blog`, as HTML;
     - date: `article:published_time`, else the first `time[datetime]`,
       else the list date.
   - **guid** is the post URL (as before).
   - **No Markdown.** The old providers converted to Markdown for their Atom
     output. The reader renders sanitised HTML, so Turndown goes.
   - A plugin that finds **0** posts throws "page layout changed" and counts
     as a failure (§4), so a broken selector shows as a failing feed instead
     of a silent empty one.

HTML parsing in plugins and discovery: `cheerio` 1.2.0 (2026-01-23), loading
a string with `cheerio.load`. It does not fetch; we fetch through `SafeFetch`.

## 7. The old public Atom output (`/:namespace/:route`): the owner's choice

| Option | What it is | Cost |
| --- | --- | --- |
| **a. Drop it** | v1 has no public feed output | none; anyone subscribed to the old URLs loses them (no data says anyone is) |
| **b. Keep for built-in sources** | `GET /feeds/cursor-blog.xml`, public, from stored entries | one route handler and a feed generator dependency (`feed` on npm, the same jpmonette generator cursor.com uses); cached with Next.js `revalidate`; public reads of our database |
| **c. Per-user Atom export behind an API key** | `GET /api/feeds/:id/atom?key=…` (or all unread), so any reader app can follow rssify | the same generator, plus API-key auth in a query string (a key in a URL leaks into logs; most feed readers cannot send headers); interacts with state's API-key scopes |

b and c are additive and could come later. I would not build either before
the reader works. Not decided here: question O2.

## 8. Fetch hygiene and SSRF

All outbound requests (feeds, discovery, plugins) go through one
`safeFetch(url, { etag, lastModified })`.

- **Client.** `undici` 8.12.3 `fetch` with a dedicated `Agent`, not the
  global fetch.
- **SSRF.** We wrap the agent's connector: undici's `Connector.md` documents
  that the function built with `buildConnector` "may be passed … as the
  `connect` option of a Dispatcher, or wrapped to perform extra validation on
  each socket". After connect, we check `socket.remoteAddress` with
  `ipaddr.js` 2.5.0 and destroy the socket unless `range()` is `unicast`.
  That blocks loopback, private, link-local (including `169.254.169.254`),
  CGNAT, ULA, multicast and IPv4-mapped forms.
  - Checking the address of the actual connection, not a separate DNS
    lookup, closes DNS rebinding and covers every redirect hop.
  - Why not a ready-made library: `request-filtering-agent` 3.2.1 is an
    `http.Agent` and its README says Node's built-in `fetch` does not support
    it; `ssrf-req-filter` is the same kind and was last published 2024.
  - The wrapper is about 20 lines. It is the one piece of our own network
    code, and it is tested with `127.0.0.1`, `[::1]`, `10.0.0.1`,
    `169.254.169.254` and a public fixture server.
- **URL rules.**
  - `http:` or `https:` only, and ports 80/443 only. Feeds on other ports are
    not supported in v1; this closes internal port probing.
  - No credentials in the URL.
  - At most 2,048 characters.
- **Redirects.** `redirect: 'manual'`, at most 5 hops, the URL rules
  re-checked at each hop.
  - We do not rewrite the stored URL on a 301/308; a moved feed costs one
    extra hop per fetch.
  - Discovery stores the final URL of the add.
- **Timeouts.**
  - 15 s for the whole request (`AbortSignal.timeout`), 10 s for a plugin's
    post pages.
  - Measured: most feeds answered in 75–1,100 ms; `simonwillison.net` took
    7 s.
- **Size cap.** 10 MB, counted while streaming; abort and fail with "feed too
  large". The largest measured feed was 3.9 MB (Vercel changelog Atom). The
  cap is on what we read, not on a response we serve, so the 4.5 MB function
  body limit (https://vercel.com/docs/functions/limitations) does not apply.
- **Compression.** undici's fetch decompresses gzip/br; the cap counts
  decoded bytes.
- **User agent.** `rssify/1.0 (+https://github.com/IKatsuba/rssify)`.
  - It is honest, and both sources accept it. NYT's homepage answered 403 to
    it; its RSS endpoint answered 200.
  - `Accept: application/rss+xml, application/atom+xml, application/feed+json,
    application/xml;q=0.9, text/html;q=0.8, */*;q=0.5`.
- **Content-Type** is not trusted. Measured feeds came as `text/xml`,
  `application/xml`, `application/json` and `text/html`. We sniff the body
  instead (`{` → JSON Feed, `<` → XML, else not a feed).
- **Rate.** One request per feed per interval, conditional when possible,
  plus `Retry-After` honoured (§4). With shared feed rows, 100 users
  subscribed to one feed still produce one fetch.

## 9. Failure cases

| Case | Measured or reasoned | Behaviour |
| --- | --- | --- |
| Malformed XML (truncated) | rowanmanning returned 8 of 16 items from half an RSS file; threw on half an Atom file | Partial items are upserted (harmless: real items). If parsing throws: failure, `lastError = "not a valid feed"` |
| HTML instead of a feed | all three parsers throw on `cursor.com/blog`'s HTML | on add, run discovery; on refresh, a failure ("the address no longer returns a feed") |
| Empty channel | parses to 0 items | success with 0 entries; not a failure (only a plugin's 0 is) |
| Empty body | parsers throw | failure |
| Huge | Vercel Atom 3.9 MB / 1,691 entries parses in 86 ms | parse it; upsert the newest 100; over 10 MB: abort, failure |
| Wrong encoding | koi8-r and ISO-8859-1 feeds | decode as in §5 |
| Moved (301/308) | `claude.com/blog` → `/resources/articles`; `claude.dev/blog` → `/` | follow up to 5 hops, URL kept as stored |
| Gone (410) | reasoned | `status = gone`, polling stops, the reader sees it |
| 404 / 5xx / DNS error | reasoned | backoff to daily, `status = failing` after 3 |
| Slow | 7 s measured; 15 s cap | timeout counts as a failure |
| Rate limited (429/503 + `Retry-After`) | reasoned | wait at least `Retry-After`, at most 24 h |
| Blocked (403) | NYT homepage to our UA | a failure like any 4xx; no UA spoofing |
| Message delivered twice | documented at-least-once | upsert by `(feedId, guid)`; usually a 304 the second time |
| Cron fired twice or missed | documented best effort | the claim is atomic, so a duplicate finds nothing; a missed tick means the next takes the backlog |
| Consumer crashes or times out | documented redelivery | 60 s retry, at most 3 deliveries; after that the 30-min lease lets the next tick pick the feed up |
| Plugin page layout changed | claude.com today: 0 matches | 0 posts throws, the feed shows failing |
| Site renders only in a browser | none today (§6) | not supported in v1; it shows as failing ("page layout changed") |

**Fixtures to save in the repository** (ship team, under the test fixtures
directory state picks). Hand-write synthetic fixtures with invented content
and example domains, keeping only the structures below; never save live pages.
Retain plugin canonical hosts only where needed and use a one-line README
saying the fixtures are synthetic.

- `claude.dev/rss.xml` (RSS 2.0, ETag)
- `cursor.com/changelog/rss.xml` (RSS 2.0 with `content:encoded`)
- `news.ycombinator.com/rss` (no guid)
- `rss.slashdot.org/Slashdot/slashdotMain` (RDF, ISO-8859-1)
- `opennet.ru/opennews/opennews_all.rss` (koi8-r)
- `github.com/vercel/next.js/releases.atom` (Atom, HTML content)
- `xkcd.com/atom.xml` (small Atom)
- `jsonfeed.org/feed.json` (JSON Feed 1.0)
- `daringfireball.net/feeds/json` (1.1)
- `cursor.com/blog` and one post (plugin)
- a truncated copy of one of the above
- `cursor.com/blog`'s HTML as "not a feed"
- an Atom with `xml:base` and hostile HTML (the snippet in §5)

## 10. Build units (ingest's part)

These follow the shared first unit (remove Deno, init Next.js with the
preset, docker compose, Prisma, auth) and state's schema unit:

1. **`safeFetch`**: undici agent with the SSRF connector, URL rules,
   redirects, timeout, size cap, conditional headers, decoding. Unit tests
   against a local fixture server and blocked addresses.
2. **Parse and normalise**: `@rowanmanning/feed-parser` + the JSON Feed
   mapping + identity + `sanitize-html`. Fixture tests (§9).
3. **`refreshFeed(feedId)`**: fetch or plugin → normalise → upsert → due and
   backoff writes. Integration tests on the docker Postgres with a stubbed
   fetch.
4. **Add feed**: discovery + plugin match + inline first refresh, as a server
   action that interface's screen calls.
5. **Refresh loop**: `fanOut` + `scripts/refresh.ts` + the cron route
   (`CRON_SECRET`) + the consumer route + `vercel.json` + `@vercel/queue`.
6. **`cursor-blog` plugin** and the two built-in rows (claude.dev RSS, cursor
   plugin), with fixture tests.
7. (Only if the owner picks 7b or 7c.) Atom output.

Dependencies added by ingest: `@vercel/queue` 0.8.0,
`@rowanmanning/feed-parser` 2.1.5, `sanitize-html` 2.18.1, `cheerio` 1.2.0,
`undici` 8.12.3, `ipaddr.js` 2.5.0. Removed with Deno: Astral, deno-dom,
Turndown, Redis.

## 11. Closing lists

### Decisions made (ingest)

1. `vercel.json` is required: `crons` + one `queue/v2beta` trigger. Given
   whole in §1. `@vercel/schedules` is not used (alpha, no docs).
2. Cron `*/15 * * * *`. Default feed interval 60 min, exponential backoff to
   24 h, stop only on 410.
3. Fan-out claims due feeds atomically with a 30-min lease, at most 500 per
   tick, one `send` per feed with an idempotency key.
4. The consumer records source failures in Postgres and acknowledges;
   queue retries only for our own failures (`maxDeliveries: 3`).
5. One `refreshFeed(feedId)` for consumer, add-feed, script and tests. The
   seam is a function argument, not a fake queue.
6. Parser: `@rowanmanning/feed-parser` + own JSON Feed mapping (option A of
   three).
7. We decode bytes by header → BOM → prolog → UTF-8.
8. Identity: `(feedId, guid ?? url ?? hash)`. `publishedAt` is null when
   unknown, never "now". At most 100 newest entries per fetch.
9. Sanitise once at ingest with `sanitize-html`; store sanitised HTML plus a
   plain-text summary; no Markdown.
10. Discovery from `<link rel=alternate>` only; no path guessing.
11. No headless browser. Claude Code becomes a plain RSS feed; Cursor is the
    one plugin; plugins are a const map in code.
12. `safeFetch`: undici + socket-address check (SSRF), http/https on 80/443,
    5 redirects, 15 s, 10 MB, honest UA.

### Questions for the owner

- **O1. Which Claude blog is the built-in "claude-code" source?**
  - (a) `https://claude.dev/rss.xml`, the Claude Code / developer blog. Real
    RSS, no scraping. **Recommended.**
  - (b) `claude.com/resources/articles`, what `claude.com/blog` now redirects
    to: product news, partner and customer posts, plus links out. It needs a
    plugin on hashed CSS-module class names, sees only 12 cards, and has
    duplicates.
  - (c) Both, as two built-in sources.
- **O2. The old public Atom output** (§7): (a) drop, (b) keep for built-in
  sources, or (c) per-user export behind an API key. I lean to (a) for v1.
- **O3. Feeds on non-standard ports** (`:8080` and the like): unsupported in
  v1 for SSRF simplicity. Is that acceptable?

### Questions for state

- **S1.** The feed-row fields in §4 (`plugin`, `etag`, `lastModified`,
  `nextFetchAt`, `lastFetchedAt`, `lastSuccessAt`, `failureCount`,
  `lastError`, `status`) and a unique `url`.
- **S2.** Entries: unique `(feedId, guid)`; nullable `publishedAt`; a
  first-seen timestamp for sorting; `summary` text and `contentHtml`. On
  upsert, never change `publishedAt` once set, nor read state.
- **S3.** "Due" counts only feeds with at least one subscription: a
  subquery, or a stored count? Your call. When the last subscriber leaves,
  do we keep the row (simplest) or delete it?
- **S4.** Neon cost of a 15-min cron on your chosen Neon plan (§3). If it
  matters, say so and I move to hourly.
- **S5.** The test seam in §2 (call `refreshFeed` and `fanOut(spy)`
  directly; stub fetch with fixtures; nothing imports `@vercel/queue`) and
  where the §9 fixtures live.
- **S6.** Who seeds the two built-in feed rows (migration or seed script)?

### Questions for interface

- **I1.** Add feed:
  - when discovery finds several feeds, show a pick list (my
    recommendation) or take the first;
  - the error texts: "No feed found at this address", "That address is not
    allowed" (SSRF), "The site did not answer in time", "The feed is too
    large (over 10 MB)";
  - the add action takes 1–7 s, so it needs a pending state.
- **I2.** A failing feed shows `lastError` and `lastSuccessAt`; a `gone` feed
  says it stopped. `status` is per feed, so every subscriber sees the same.
- **I3.** Do you want the optional "refresh now" (§3)? Nearly free, not
  required.
- **I4.** The reader renders `contentHtml` as-is (already sanitised), and
  falls back to `summary`, then a link to `url`. Images are hot-linked.
