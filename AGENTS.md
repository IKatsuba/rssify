# AGENTS.md

## Project Overview

rssify is a serverless RSS reader built with Next.js App Router, React,
shadcn/ui (preset b1D0dxmC, Base UI), Tailwind CSS, Prisma 7 and better-auth.
Bun is the package manager and test runner. The session-only reader uses
Vercel sign-in, marks entries read on open and manages API keys in Settings.
It shares subscriptions and read-state operations with API-key-only
`/api/v1`. Ingest has guarded HTTP, feed parsing, sanitising, refresh and
add-feed helpers, cron and queue scheduling, and a Cursor blog source plugin.

## Commands

Run from the repository root:

```bash
bun install
bunx prisma generate                 # After clone or a schema change
cp .env.example .env.local            # Once; fill local auth settings
docker compose up -d                 # Local Postgres, port 54329
bun --env-file=.env.local run prisma migrate dev
bun run dev                          # http://localhost:3210
```

Whole check (with local Postgres running):

```bash
bun run lint && bun run typecheck && bun run test
```

Run one test file: `bun run test ./lib/auth.test.ts`. This forwards the
file to Bun after applying test migrations, just like `bun run test`.
The test script defaults to local `rssify_test` and needs no env setup.
Use targeted tests while editing; run the whole check at the unit handoff
and final gate. Run heavy checks in the background and read their result
before starting another. The safe-fetch TLS test needs local `node` and
`openssl`.

```bash
bun run build                        # Production build
bun run start -p 3210                 # Serve that build locally
bun run format                       # Format TypeScript/TSX
bun --env-file=.env.local scripts/dev-session.ts [email]
bun --env-file=.env.local scripts/dev-seed.ts [email]
bun --env-file=.env.local scripts/refresh.ts
```

The session helper creates a local user and session without Vercel and
prints a session cookie to set on localhost:3210. It accepts only a local
Postgres host; its default user is `reader@example.com`.

The seed script accepts only a local Postgres host and creates mock feeds
and entries for reader screen checks, defaulting to `reader@example.com`.
Reruns replace the mock feeds, moving them to the chosen user when the
email changes; real feeds are left alone. Mock feeds are not due for refresh.

The refresh script accepts only a local Postgres host and runs one claim
and refresh cycle inline, without a queue.

## Architecture

- `app/`: App Router pages, server actions and Route Handlers. `/sign-in`
  redirects signed-in users to `/`; otherwise it shows Vercel sign-in,
  redirecting, registration-closed or error states.
- `app/(reader)/`: session-only layout with a responsive sidebar, unread
  badges, failing/gone markers and an email menu for Settings, shortcuts,
  theme and sign-out.
  `/` and `/feeds/[feedId]` show Unread (default) or All, Older/Newer paging,
  empty states and feed notices. Mark all as read confirms the list scope,
  uses `asOf` as the cutoff, is disabled at zero unread and toasts the actual
  marked count. The feed menu opens the website when `siteUrl` exists,
  copies the feed URL and marks all read. Unsubscribe confirms, then returns
  to `/` with a toast. The sidebar + and no-feeds state open Add a feed:
  a URL or built-in source, Subscribed badges, Adding… state, discovered
  URL choices with Back, and errors under the field or source. Success
  opens `/feeds/[id]` with a toast; `lib/add-feed-errors.ts` maps error codes.
  `/entries/[entryId]?feed=&filter=` shows stored sanitised content,
  falling back to summary or a no-text state, with Back, scoped previous/next,
  Open original and Mark as read/unread. Opening marks read after client
  mount, never during server rendering or prefetch. `lib/intent-queue.ts`
  serialises optimistic read changes so the last intent wins; a failed
  latest change restores the confirmed state and shows an error toast.
  Routes have loading and not-found states; `(reader)/error.tsx` retries
  page and sidebar queries together through `rssify:retry` and the sidebar's
  `catchError` boundary. Sonner supplies reader toasts.
  `app/error.tsx` catches reader layout failures. `data.ts` caches session
  and subscription reads per request; the layout title includes unread count.
- `app/(reader)/settings/`: `/settings` has Account (email and Sign out),
  API keys and Keyboard shortcuts (Show and Turn off/on) cards, loading and
  error states, and the title `Settings · rssify`. Keys list newest first
  with name, eight-character start, Created and Last used (Never if unused);
  dates are hidden on phones. Create takes a trimmed 1–64-character name,
  then opens a shown-once dialog with a masked field and Copy for the full
  key; closing drops the secret. Revoke confirms first; failures toast.
- `app/(reader)/keys.tsx`: one reader shortcut listener. Lists use j/k for
  the cursor, o/Enter to open (Enter on body or a row), m to toggle read,
  v for the original and r to refresh, even when empty. Entries use j/k
  for next/previous, u/Esc for Back, m and v. Both use a for Add a feed,
  Shift+A to confirm marking their list read (Enter confirms), and ? for
  Keyboard shortcuts. The dialog also opens from the email menu and has
  Turn shortcuts off/on. Tooltips and menus show platform-specific hints.
  `lib/list-cursor.ts` holds cursor logic; `return-point.ts` saves the page,
  scope and current entry in sessionStorage. The cursor starts on the first
  row; Back restores the current entry's row, including after j/k crosses
  pages, or falls back to the first row. Under Unread, m keeps its index,
  clamped to the remaining rows.
- `app/(reader)/actions.ts`: session-only `subscribe`, `unsubscribe`,
  `markRead`, `markUnread` and `markAllRead` server actions use `requireUser`
  and its user ID, then revalidate `('/', 'layout')`. Subscribe also returns
  the feed title (URL fallback) for toasts. `createApiKey` and `revokeApiKey`
  use `lib/api-keys.ts` with session headers, as does the Settings list
  loader; a key cannot manage keys. Actions parse inputs after the session
  check and throw `TypeError` for invalid input. API keys do not grant access.
- `lib/reader-schemas.ts`: shared Zod 4 inputs for actions and `/api/v1`.
  Subscribe accepts exactly one of `{ url }` or `{ source }`; mark-all
  accepts a Date or ISO datetime `upTo`. Zod is a direct dependency.
- `app/api/v1/`: JSON Route Handlers over `lib/api-v1.ts` and `lib/reader.ts`,
  each with `maxDuration = 60`. Only `x-api-key` authenticates; cookies do not.
  GET/POST `subscriptions` list or subscribe (201 new, 200 existing);
  DELETE `subscriptions/[feedId]` returns 204. Subscription feeds expose
  `pluginId` (null for plain feeds). GET `entries` accepts `feedId`,
  `unread=true|false`, `limit` (1–100, default 50) and `cursor`, returning
  `{ entries, nextCursor, asOf }`. GET `entries/[id]` includes `contentHtml`
  without marking read. PUT/DELETE `entries/[id]/read` return 204;
  POST `entries/read` takes `{ feedId?, upTo }` and returns `{ marked }`.
  Errors use `{ error: { code, message } }`: 400 `invalid_input`, 401,
  404 for missing or inaccessible data, 422 for subscribe failures (the
  add-feed sentence and discovery `choices` when present), and 429.
- `app/api/auth/[...all]/route.ts`: better-auth GET/POST handler.
  `lib/auth.ts` configures Vercel OAuth, Prisma, the registration gate,
  sessions and API keys; `lib/auth-client.ts` starts browser sign-in.
- `lib/actor.ts`: session-only user/admin guards and an `x-api-key` guard.
  `requireUser` also returns email for display; ownership uses user ID.
  Keys never grant admin access or use session cookies; invalid keys return
  401, and rate-limited keys return 429 with `Retry-After`.
- `lib/reader.ts`: user-scoped subscriptions with unread counts, entry
  queries ordered by `sortAt`/id descending with keyset paging, and scoped
  neighbours. `getEntryNavigation` also returns a page cursor for Back.
  `listEntries` accepts `cursor` for older or `before` for newer
  (`before` wins), returning `nextCursor` and `prevCursor`. Reads do not mark
  entries read; read/unread writes are idempotent, and mark-all uses the
  list's `asOf` as its `upTo` cutoff.
  Inaccessible data returns `not_found`. `subscribe(userId, { url } | { source })`
  checks the 500-subscription cap first (`limit`), resolves built-in sources
  (unknown IDs return `not_found`) and normalises URLs without fragments.
  Existing feeds need no fetch. New feeds are fetched outside the transaction;
  one transaction locks the user, rechecks the cap, inserts the feed, first
  entries, success polling fields and subscription. A URL conflict subscribes
  to the winner's feed. Failures write nothing; DB errors throw. Last
  unsubscribe deletes the feed, entries and read marks in one transaction.
- `lib/reader-view.ts`: reader URL parameters and links, empty states and
  feed notices. `lib/relative-time.ts` formats short list times and relative
  sentences with Intl; future dates read as now.
- `lib/ingest/add.ts`: `fetchForAdd` uses `safeFetch` with a 15 s deadline
  and parses against the final response URL. The add path discovers HTML
  after parse failure, using body sniffing or an HTML Content-Type:
  no links returns `not_found`, several return `multiple` with `choices`,
  and one rechecks stored feeds before a separate 15 s fetch. Discovery
  stops there; another HTML page returns `not_found`. Direct feeds keep the
  normalised input URL after redirects; discovery stores the discovered URL.
  HTTP 404/410 and non-feeds return `not_found`, other non-2xx responses
  `unreachable`; `SafeFetchError` codes pass through. A matching plugin gets
  one 40 s deadline; fetch errors keep their code and list-page HTTP errors
  map as above. Other throws or zero entries return `not_found`.
- `lib/ingest/discover.ts`: `discoverFeeds(html, pageUrl)` uses cheerio to
  read alternate RSS/Atom/RDF/JSON Feed links, resolving against `<base>`
  or the final page URL. It returns deduplicated HTTP(S) URLs in document
  order, with no path guessing.
- `sources/`: `builtinSources` maps `claude-code` to
  `https://claude.dev/rss.xml` and `cursor-blog` to `https://cursor.com/blog`.
  `SourcePlugin` defines `fetchEntries` with guarded fetch, known-URL lookup
  and a shared deadline; `pluginFor` matches the URL exactly against
  `matches`. The registered `cursor-blog` plugin reads static HTML with
  cheerio: article links must be same-origin HTTPS `/blog/` post URLs;
  query/hash are stripped and duplicates removed in document order.
  It fetches at most 10 unknown posts per run, four at a time, using URLs
  as guids. Entries use `og:title` minus trailing ` · Cursor`, meta
  description and the first `.prose--blog`, with normal feed normalisation
  and sanitising. Dates use the first valid `article:published_time`,
  post `time[datetime]`, then list date. No post links throws
  "the page layout changed"; failed post fetches are skipped for this run.
  A non-2xx list page throws `SourceStatusError` with status and headers.
  Built-in source feeds are created on subscribe, never seeded.
- `lib/ingest/fan-out.ts`: `fanOut(enqueue)` claims up to 500 due,
  subscribed feeds, oldest first, in one SQL statement with
  `FOR UPDATE SKIP LOCKED`, setting `nextFetchAt` to a 30-minute lease.
  Gone feeds have null `nextFetchAt` and are not claimed. It enqueues 50
  at a time with `Promise.allSettled`, logs failed sends and leaves them
  leased. It stops starting chunks after 240 s; unsent feeds stay leased
  too. Lost messages and failed sends come due again when the lease expires.
  Returns `{ claimed, sent, failed }`.
- `app/api/cron/refresh/route.ts`: GET with `maxDuration = 300`, using
  `lib/ingest/cron.ts`. Unset or empty `CRON_SECRET` returns 500; a header
  other than exactly `Authorization: Bearer ${CRON_SECRET}` returns 401.
  It calls `fanOut` with `@vercel/queue` sends to `feed-refresh`, body
  `{ feedId }` and ``idempotencyKey: `${feedId}:${tick}```, where `tick` is
  the run start floored to 15 minutes as an ISO timestamp. Returns counts.
- `app/api/queues/refresh-feed/route.ts`: POST via `handleCallback`, with
  `maxDuration = 60`. `lib/ingest/consumer.ts` calls `refreshFeed` with
  `skipIfFreshWithin: 120`; malformed messages without a string `feedId`
  are logged and acknowledged. Missing feeds and source failures are
  acknowledged; DB errors throw for redelivery. The consumer has no auth
  code of its own: it assumes Vercel keeps trigger consumers private
  (design §5.6). The owner must verify this on the first deploy.
- `vercel.json`: `crons` runs `/api/cron/refresh` on `*/15 * * * *`;
  `experimentalTriggers` binds the consumer to `queue/v2beta`, topic
  `feed-refresh`, with `maxDeliveries: 3`.
- `lib/ingest/refresh.ts`: `refreshFeed(feedId, { skipIfFreshWithin, fetch,
  plugins, now })` uses conditional `safeFetch` with a 15 s deadline for
  feeds, parsing against the final response URL without changing the stored
  URL. Missing feeds return; `skipIfFreshWithin` skips recent fetches
  (seconds). Plugin feeds get one 40 s deadline and `known()` checks stored
  guids for that feed. Plugin success uses the same storage and scheduling,
  without validators or changing title/siteUrl. Unknown plugin IDs fail with
  "the source isn’t supported any more"; fetch errors use the usual texts,
  list-page HTTP errors use the status handling below, and other throws
  store their message. Database errors, including in `known()`, throw even
  if the plugin catches them.
  Shared `storeEntries` takes the newest 100 items by `sortAt`, with document
  order breaking ties and `sortAt = min(publishedAt ?? now, now)`.
  `(feedId, guid)` duplicates keep the first version. In one transaction,
  it inserts, retains the newest 500 by `(sortAt, id)` descending and
  updates the feed; DB errors throw and roll back. Retained entries keep
  read marks; pruning cascades them. Success (including 304) resets
  failures and schedules +60 min; new feeds use the same `successFields`.
  Failures use `min(60 min × 2^failureCount, 24 h)` with the incremented
  count and set `failing` at 3; 429/503
  honour longer `Retry-After` delays up to 24 h. HTTP 410 sets `gone`
  with no next fetch. Each fetched outcome writes `lastFetchedAt` once;
  source failures store `lastError` and return normally.
- `lib/ingest/safe-fetch.ts`: the only outbound HTTP path for ingest.
  `safeFetch(url, { etag, lastModified, deadline })`
  uses its own undici Agent, conditional GET and feed-preferring headers.
  Every hop requires HTTP(S), ports 80/443, no credentials and at most
  2,048 URL characters. All DNS answers must be public unicast addresses;
  ipaddr.js checks mapped IPv6 as IPv4. The connected remote address is
  checked again, while TLS keeps the hostname and certificate checks.
  At most five redirects share one deadline with the body (15 s by default).
  Bodies are capped at 10 MB after decompression; charset comes from
  Content-Type, BOM, XML prolog, then UTF-8. Non-2xx statuses return with
  headers and empty text. Failures throw `SafeFetchError` with code
  `invalid_url`, `blocked`, `unreachable` or `too_large`.
- `lib/ingest/parse.ts`: `parseFeed(text, feedUrl)` reads RSS/Atom/RDF
  with `@rowanmanning/feed-parser` and maps JSON Feed directly. It returns
  feed metadata and normalised `IngestedEntry` values in document order.
  `FeedParseError` codes are `not_a_feed` and `invalid_feed`.
  `normaliseEntry` chooses guid from nonblank id, safe
  absolute URL, then SHA-1 of title + ISO publishedAt (empty when undated).
  `publishedAt` uses valid published, then updated, then null, never now.
  Titles and summaries are plain text; summaries cap at 300 code points.
  Missing titles use the first 80 summary code points, then `(untitled)`.
  Atom text constructs and JSON Feed plain text stay literal text.
- `lib/ingest/sanitize.ts`: `sanitizeContent(html, baseUrl)` uses
  `sanitize-html` defaults plus media tags and an attribute allowlist.
  It resolves href/src, allows HTTP(S)/mailto, drops active markup,
  style and srcset, and forces `rel="noopener noreferrer nofollow"` and
  `target="_blank"` on links. Output caps at 200 KiB of UTF-8 with tags
  closed and code points intact; empty output is null. `plainText`
  strips markup and collapses whitespace; `safeUrl` resolves URLs and
  allows HTTP(S) only. Fixtures in `test/fixtures/feeds/` and
  `test/fixtures/cursor-blog/` are local; tests never fetch them.
- `prisma/schema.prisma` and `prisma/migrations/`: auth, API-key, feed,
  entry, subscription and read-mark storage. Generated Prisma code lives
  in gitignored `lib/generated/prisma/`; regenerate it rather than edit it.
- `lib/db.ts`: one Prisma client on `globalThis`, reused across hot reloads
  and warm functions. Uses PrismaNeon for `.neon.tech` hosts, PrismaPg
  otherwise. `prisma.config.ts` prefers a nonempty
  `DATABASE_URL_UNPOOLED`, falling back to `DATABASE_URL` for CLI commands.
- `components/ui/`: shadcn components; `components/theme-provider.tsx`
  handles light/dark/system themes. `app/globals.css` enables
  `@tailwindcss/typography` for entry prose and reduces motion when requested.
  `@/` imports resolve from the repository root.

## Key patterns

- `isAdmin` requires a verified email matching trimmed, case-insensitive
  `ADMIN_EMAIL`. Registration is open only when `REGISTRATION_ENABLED`
  is exactly `true`; the verified admin can register while it is closed.
  Existing users can still sign in.
- Session cookies are cached for five minutes. API keys use the `rss_`
  prefix, an eight-character visible start including the prefix and a
  default limit of 120 requests per minute.
- `lib/keys.ts` defines the key map, switch helpers and `canHandleKey` guard;
  the theme's d listener also uses the guard. Shortcuts default on; localStorage
  `rssify:shortcuts` set to "off" disables them. The guard rejects typing
  targets, open dialogs/sheets/menus and modifiers except Shift. Only
  handled keys prevent default; Space and / keep browser behaviour.
  The template's ⌘B/Ctrl+B sidebar chord stays independent of the switch.
- Keep safe-fetch's `undici/index.js` import: `bun test` substitutes a shim
  for bare `undici` that ignores the custom Agent and bypasses the guard.
  Next's build bundles `undici/index.js` into the consumer route.
  `createSafeFetch({ lookup, allowAddress, ports })` is the test seam; only
  test files may pass `allowAddress` or `ports`. There is no env or flag
  bypass. Safe-fetch tests use fake resolvers and only 127.0.0.1 sockets.
- `bunfig.toml` preloads `test/db.ts` for every test file. Before each test
  it truncates tables except `jwks` and `_prisma_migrations`. The guard
  requires a Postgres URL whose driver-parsed host is `localhost` or
  `127.0.0.1` and database is `rssify_test`, including query overrides.
  Keep tests serial; never use a real account or contact live services.
- Fan-out and cron tests inject the enqueue seam; consumer tests call
  `refreshFromMessage` with guarded fetch fixtures. Tests never import
  `@vercel/queue` or send to a real queue.
- Keep Prisma migrations committed. Use explicit `--env-file=.env.local`
  for dev Prisma commands; bare `bunx` and package scripts do not reliably
  load that file. Tests set both database URL variables themselves.

## Environment Variables

Copy names and local defaults from `.env.example`; keep secrets out of
commits, fixtures and messages.

- `DATABASE_URL`: application DB; local default
  `postgresql://rssify@localhost:54329/rssify`.
- `DATABASE_URL_UNPOOLED`: optional CLI migration connection; leave empty
  locally to use `DATABASE_URL`.
- `TEST_DATABASE_URL`: test-script override; defaults to
  `postgresql://rssify@localhost:54329/rssify_test`.
- `BETTER_AUTH_SECRET`: local session-signing secret.
- `BETTER_AUTH_URL`: auth origin, `http://localhost:3210` locally.
- `VERCEL_CLIENT_ID`, `VERCEL_CLIENT_SECRET`: Vercel OAuth credentials.
- `ADMIN_EMAIL`: verified admin email; unset means no admin.
- `REGISTRATION_ENABLED`: defaults to `false`.
- `CRON_SECRET`: required bearer secret for the refresh cron route.
- `VERCEL_ENV`: supplied by Vercel; `vercel-build` generates Prisma,
  deploys migrations on production/preview, then builds Next.js.

## Local stack

Docker Compose runs Postgres 17 on `127.0.0.1:54329` with trust auth and
user `rssify`. A fresh volume creates `rssify` and `rssify_test` via
`docker/postgres-init.sql`. Next.js dev runs on port 3210. Queue and cron
do not run locally. Deploys, Neon access, real queues and Vercel linking
or environment changes belong to the owner.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
