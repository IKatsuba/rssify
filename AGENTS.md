# AGENTS.md

rssify is a simple serverless RSS reader: Next.js App Router, shadcn/ui
(preset b1D0dxmC, Base UI), Prisma 7 on Neon, better-auth (Sign in with
Vercel, API keys, MCP OAuth), Vercel Cron and Queues. Bun is the package
manager and test runner. The web UI, `/api/v1` and the MCP server at
`/api/mcp` all call one set of operations in `lib/reader.ts`.

Keep it simple: the smallest code that does the job, a maintained library
before our own code, no workaround around a library that does not fit (stop
and ask instead).

## Commands

```bash
bun install
bunx prisma generate                  # after clone or a schema change
cp .env.example .env.local            # once
docker compose up -d                  # Postgres 17 on 127.0.0.1:54329
bun --env-file=.env.local run prisma migrate dev
bun run dev                           # http://localhost:3210
```

Whole check (local Postgres running):

```bash
bun run lint && bun run typecheck && bun run test
```

- One test file: `bun run test ./lib/auth.test.ts`. Tests use the local
  `rssify_test` database and need no env setup.
- A fresh clone needs `bunx next typegen` before `bun run typecheck`.
- `bun run build` for a production build; CI runs the whole check and the
  build on every PR and push to `main` (`.github/workflows/ci.yml`).
- Run targeted tests while editing and the whole check before a commit is
  handed on. Run heavy commands in the background, one at a time.

Local helpers (each refuses a non-local database):

```bash
bun --env-file=.env.local scripts/dev-session.ts [email]  # session cookie
bun --env-file=.env.local scripts/dev-seed.ts [email]     # mock feeds
bun --env-file=.env.local scripts/refresh.ts              # one refresh cycle
```

## Where things are

- `app/`: pages, server actions, Route Handlers. `(reader)/` is the
  signed-in UI; `api/v1`, `api/mcp`, `api/cron/refresh`,
  `api/queues/refresh-feed` and `.well-known/` are the machine endpoints.
- `lib/reader.ts`: subscriptions, entries and read state; the one
  implementation behind actions, `/api/v1` and MCP. Inputs are the zod
  schemas in `lib/reader-schemas.ts`, shared by all three.
- `lib/actor.ts`: who is calling (session, API key, MCP token); every route,
  action and tool goes through it.
- `lib/auth.ts`: better-auth config, `isAdmin`, the registration gate.
- `lib/ingest/`: fetching (`safe-fetch.ts`), URL canonicalisation
  (`target.ts`), discovery, parsing and sanitising, add-feed, refresh,
  cron fan-out and the queue consumer.
- `sources/`: source plugins and built-in sources for sites without a
  usable feed.
- `lib/mcp/`: the MCP server and its route.
- `prisma/`: schema and committed migrations.
- `design/rssf-*/DESIGN.md`: the design behind each feature. Read the one a
  task names; it is the specification, not this file.

## Rules that are easy to get wrong

- Every route, action and MCP tool checks the caller through `lib/actor.ts`
  before reading or writing. An API key or MCP token never grants admin.
- All ingest HTTP goes through `safeFetch` (SSRF guard, limits). Keep its
  import of `'undici/index.js'`: `bun test` shims bare `'undici'` and would
  bypass the guard. `allowAddress`/`ports` on `createSafeFetch` are for
  tests only. CIMD client metadata uses `@better-auth/cimd`'s own guarded
  fetcher by design.
- Feed HTML is sanitised once, at ingest; render stored content as is.
- A plugin is found by `canonical(url)`; the canonical URL is stored in
  `Feed.url` and is the plugin's whole configuration. Changing a shipped
  canonical form needs a migration that merges duplicates.
- Reading an entry through `/api/v1` or MCP never marks it read; the UI
  marks on open.
- The queue consumer has no auth of its own: Vercel keeps queue consumers
  private. Never add a public route that calls `refreshFeed`.
- Prisma: one client per instance (`lib/db.ts`), schema changes only
  through a committed migration, dev commands with
  `bun --env-file=.env.local`.
- `BETTER_AUTH_SECRET` must stay stable: it encrypts the JWKS signing key.

## Tests

- Colocated `*.test.ts`. `test/db.ts` (preloaded by `bunfig.toml`) only
  accepts a local `rssify_test` database and truncates tables between tests.
- Tests never reach the live network, Neon, Vercel or a real queue: feeds
  are fixtures under `test/fixtures/`, the queue is the `fanOut(enqueue)`
  seam, safe-fetch tests use 127.0.0.1 sockets.
- `.well-known` route tests live in `lib/well-known*.test.ts` because Bun
  skips dot-directories.

## Environment

Names and local defaults are in `.env.example`; never commit a secret.
`DATABASE_URL`, `DATABASE_URL_UNPOOLED` (Neon via the Vercel integration),
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (falls back to the deployment URL
on previews), `VERCEL_CLIENT_ID`/`VERCEL_CLIENT_SECRET` (Sign in with
Vercel), `ADMIN_EMAIL`, `REGISTRATION_ENABLED` (exactly `true` opens it),
`CRON_SECRET`.

## Deploy

Vercel project `katsubadev/rssify`, production at https://rss.katsuba.dev.
A merge to `main` deploys production; `vercel-build` runs
`prisma migrate deploy` first, and a failed migration fails the build.
PRs get preview deployments. Changing Vercel settings, env or Neon is the
owner's call.

## Commits

Conventional messages as `git log` has them, signed, no trailers. One task,
one branch; never commit on `main`.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
