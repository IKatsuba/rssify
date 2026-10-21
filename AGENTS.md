# AGENTS.md

## Project Overview

rssify is a serverless RSS reader built with Next.js App Router, React,
shadcn/ui (preset b1D0dxmC, Base UI), Tailwind CSS, Prisma 7 and better-auth.
Bun is the package manager and test runner. Vercel sign-in and a signed-in
placeholder are wired up; actor and reader helpers are available but have
no UI, action or route callers yet. Ingest has guarded HTTP, feed parsing,
sanitising, refresh and add-feed helpers; scheduling and plugins are pending.

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
bun run start -p 3210              # Serve that build locally
bun run format                       # Format TypeScript/TSX
bun --env-file=.env.local scripts/dev-session.ts [email]
```

The session helper creates a local user and session without Vercel and
prints a session cookie to set on localhost:3210. It accepts only a local
Postgres host; its default user is `reader@example.com`.

## Architecture

- `app/`: App Router pages, server actions and Route Handlers. `/` requires
  a session and shows the signed-in placeholder with sign-out. `/sign-in`
  redirects signed-in users to `/`; otherwise it shows Vercel sign-in,
  redirecting, registration-closed or error states.
- `app/api/auth/[...all]/route.ts`: better-auth GET/POST handler.
  `lib/auth.ts` configures Vercel OAuth, Prisma, the registration gate,
  sessions and API keys; `lib/auth-client.ts` starts browser sign-in.
- `lib/actor.ts`: session-only user/admin guards and an `x-api-key` guard.
  Keys never grant admin access or use session cookies; invalid keys return
  401, and rate-limited keys return 429 with `Retry-After`.
- `lib/reader.ts`: user-scoped subscriptions with unread counts, entry
  queries ordered by `sortAt`/id descending with keyset paging, and scoped
  neighbours. Reads do not mark entries read; read/unread writes are
  idempotent, and mark-all uses the list's `asOf` as its `upTo` cutoff.
  Inaccessible data returns `not_found`. `subscribe(userId, { url } | { source })`
  checks the 500-subscription cap first (`limit`), resolves built-in sources
  (unknown IDs return `not_found`) and normalises URLs without fragments.
  Existing feeds need no fetch. New feeds are fetched outside the transaction;
  one transaction locks the user, rechecks the cap, inserts the feed, first
  entries, success polling fields and subscription. A URL conflict subscribes
  to the winner's feed. Failures write nothing; DB errors throw. Last
  unsubscribe deletes the feed, entries and read marks in one transaction.
- `lib/ingest/add.ts`: `fetchForAdd` uses `safeFetch` with a 15 s deadline
  and parses against the final response URL. The add path discovers HTML
  after parse failure, using body sniffing or an HTML Content-Type:
  no links returns `not_found`, several return `multiple` with `choices`,
  and one rechecks stored feeds before a separate 15 s fetch. Discovery
  stops there; another HTML page returns `not_found`. Direct feeds keep the
  normalised input URL after redirects; discovery stores the discovered URL.
  HTTP 404/410 and non-feeds return `not_found`, other non-2xx responses
  `unreachable`; `SafeFetchError` codes pass through. A matching plugin gets
  one 40 s deadline; fetch errors keep their code, other throws or zero
  entries return `not_found`.
- `lib/ingest/discover.ts`: `discoverFeeds(html, pageUrl)` uses cheerio to
  read alternate RSS/Atom/RDF/JSON Feed links, resolving against `<base>`
  or the final page URL. It returns deduplicated HTTP(S) URLs in document
  order, with no path guessing.
- `sources/`: `builtinSources` maps `claude-code` to
  `https://claude.dev/rss.xml`. `SourcePlugin` defines `fetchEntries` with
  guarded fetch, known-URL lookup and a shared deadline; `pluginFor` matches
  the URL exactly against `matches`. The plugin registry is empty; Cursor
  support is pending. Feed rows are created on subscribe, never seeded.
- `lib/ingest/refresh.ts`: `refreshFeed(feedId, { skipIfFreshWithin, fetch,
  now })` uses conditional `safeFetch` with a 15 s deadline, then parses
  against the final response URL without changing the stored URL. Nothing
  calls it yet. Missing feeds return; `skipIfFreshWithin` skips recent
  fetches (seconds); plugin feeds throw until plugins are implemented.
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
  allows HTTP(S) only. Feed fixtures in `test/fixtures/feeds/` are local;
  tests never fetch them.
- `prisma/schema.prisma` and `prisma/migrations/`: auth, API-key, feed,
  entry, subscription and read-mark storage. Generated Prisma code lives
  in gitignored `lib/generated/prisma/`; regenerate it rather than edit it.
- `lib/db.ts`: one Prisma client on `globalThis`, reused across hot reloads
  and warm functions. Uses PrismaNeon for `.neon.tech` hosts, PrismaPg
  otherwise. `prisma.config.ts` prefers a nonempty
  `DATABASE_URL_UNPOOLED`, falling back to `DATABASE_URL` for CLI commands.
- `components/ui/`: shadcn components; `components/theme-provider.tsx`
  handles light/dark themes. `@/` imports resolve from the repository root.

## Key patterns

- `isAdmin` requires a verified email matching trimmed, case-insensitive
  `ADMIN_EMAIL`. Registration is open only when `REGISTRATION_ENABLED`
  is exactly `true`; the verified admin can register while it is closed.
  Existing users can still sign in.
- Session cookies are cached for five minutes. API keys use the `rss_`
  prefix and a default limit of 120 requests per minute.
- Keep safe-fetch's `undici/index.js` import: `bun test` substitutes a shim
  for bare `undici` that ignores the custom Agent and bypasses the guard.
  `createSafeFetch({ lookup, allowAddress, ports })` is the test seam; only
  test files may pass `allowAddress` or `ports`. There is no env or flag
  bypass. Safe-fetch tests use fake resolvers and only 127.0.0.1 sockets.
- `bunfig.toml` preloads `test/db.ts` for every test file. Before each test
  it truncates tables except `jwks` and `_prisma_migrations`. The guard
  requires a Postgres URL whose driver-parsed host is `localhost` or
  `127.0.0.1` and database is `rssify_test`, including query overrides.
  Keep tests serial; never use a real account or contact live services.
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
- `CRON_SECRET`: reserved for the refresh loop; unused by Foundation.
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
