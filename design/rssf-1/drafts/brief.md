# RSSF-1 brief: rssify v1, a simple serverless RSS reader

Lead's brief for the ingest, interface and state architects and the critic.
The owner's word for everything below: keep it as simple as possible, don't
get clever.

## Owner's answers (settled, not open)

1. **Plan is Vercel Pro.** Crons may run as often as the design needs.
   Ingest's question 3 is no longer a choice for the owner: pick the cron
   interval and say why (freshness vs cost of invocations and queue
   messages). Where this brief says "Hobby", read Pro.
2. **Multi-user by design.** Registration is switched on/off by an env
   variable; the admin is named by an env email. Each user has their own
   subscriptions and read state. State's question 1 is no longer an owner
   choice: design the model for it, say what the admin can do beyond a user
   (keep it minimal), and what an API key reaches.
3. **Sign-in is through Vercel.** "Sign in with Vercel" as better-auth's
   social/OAuth provider. State checks what better-auth offers for Vercel
   today (a built-in provider or the generic OAuth plugin), the env
   variables it needs, and how it works locally. Default: no
   email/password, Vercel only. The registration flag governs whether a new
   Vercel account may create a user; the admin email matches the Vercel
   account's email. The API key plugin stays required. Interface: there is
   no sign-up form; sign-in is one "Sign in with Vercel" button, with a
   "registration closed" state.

## Problem

Today rssify is a Deno/Hono service (`main.ts`, `lib/`, `providers/`) that
scrapes two sites without RSS (claude.com/blog, cursor.com/blog) and serves
them as public Atom feeds at `/:namespace/:route`, with Redis as a cache and
Astral (headless Chromium) as a fallback scraper. There is no reader: nobody
can subscribe, read, or mark anything read.

v1 turns rssify into a reader: a person signs in, subscribes to feeds, and
reads new entries in one place. Feeds are polled in the background. A site
with no RSS gets a source plugin that turns its pages into entries. All of
the Deno side goes away; the old providers are only the record of what had to
be scraped (list page → links, titles, dates; post page → summary from
`meta[name=description]`, body from one selector, HTML → Markdown).

## What a person sees and does

- Signs in with Vercel (a new account is let in only when registration is
  switched on).
- Adds a feed by URL (an RSS/Atom URL, or a site URL whose feed is
  discovered), or picks a built-in source (the claude-code and cursor blogs).
- Sees a list of subscriptions with unread counts, and a list of entries
  (all, or per feed), newest first.
- Opens an entry and reads it; it becomes read. Can mark read/unread and mark
  all read. Keyboard keys for the common moves.
- Removes a feed. Sees when a feed is failing.
- Creates and revokes API keys, so readers and scripts can reach the API.
- The admin (named by an email in an env variable) sees what only the admin
  needs; the architects decide what that is, if anything.

## Constraints (the owner's stack, not open for debate)

- Next.js App Router + shadcn/ui, monochrome, initialised with
  `bunx --bun shadcn@latest init --preset b1D0dxmC --template next --pointer`.
  bun as the package manager.
- Neon Postgres through Prisma with its serverless driver adapter. Locally,
  Postgres in docker compose on a non-default port; the Next.js dev server on
  a non-default port too.
- better-auth. Admin named by an email env variable; registration switched
  on/off by an env variable. The better-auth API key plugin is required.
- Vercel-native: Vercel Cron triggers a fan-out that sends one
  `@vercel/queue` message per due feed; a queue consumer fetches and parses
  that one feed.
- Vercel Functions limits: execution duration (default and max differ by
  plan; Fluid compute), request/response body size, bundle size, no
  long-lived processes, no local disk beyond `/tmp`. Cold starts matter for
  the reader's pages and for the consumer. Cost: the owner is on Hobby
  unless told otherwise (crons at most once a day there); every design
  choice must say what it costs on Hobby and on Pro.
- A departure from this stack, a new service, a paid plan, a library that
  does not fit as it is, or a change of scope is the owner's: write it as a
  question with options, do not decide it.

## Non-goals (v1)

- No Redis, no separate cache service, no headless browser unless an
  architect shows v1 cannot do without one (question 5).
- No folders/tags, search, starring, sharing, OPML import/export, push
  notifications, mobile app, full-text extraction of RSS entries, or
  per-user polling schedules — unless one is nearly free; list them as
  later.
- No custom auth, custom queue, or custom cron runner when Vercel/better-auth
  gives one.
- No migration of data from the Deno service (it has none worth keeping).

## Open questions, by owner

Each architect answers its own questions in its draft, with the options
considered and the one chosen, and lists any question that is the owner's.

### ingest (`drafts/ingest.md`)

1. **Vercel Queues config, today.** The owner believes Next.js has a native
   Vercel Queues integration and `vercel.json` is not needed. The SDK docs
   (https://vercel.com/docs/queues/sdk) show App Router consumers configured
   through `experimentalTriggers` in `vercel.json`, and a native integration
   only for Nitro. Find what is true now (docs, package source/README of the
   current `@vercel/queue`), and say exactly which config is needed. Same for
   cron registration: `vercel.json` `crons` vs `@vercel/schedules` (does it
   exist, is it GA, what does it need). If `vercel.json` is needed, give it
   whole and minimal.
2. **Local and test runs of the queue.** The SDK wants `vercel link` and
   `vercel env pull` (the owner's to run; nobody here runs them). How does a
   developer run fan-out → consumer locally without them, and how do tests
   exercise it without Vercel? Prefer a seam we do not have to maintain
   (e.g. call the consumer's handler directly) over a fake queue.
3. **Cron frequency.** Hobby runs crons at most daily. Options for the owner
   (daily on Hobby; hourly/15-min on Pro; an external pinger; a "refresh
   now" button), with what each costs and what a reader experiences.
4. **What is "due".** How a feed's next poll time is decided (fixed interval,
   backoff on errors, ETag/Last-Modified, failure count), and what the
   fan-out does when it finds many due feeds (batching, the function's
   duration limit).
5. **Parsing.** Which library parses RSS/Atom/JSON Feed in Node on Vercel;
   feed discovery from a site URL; entry identity (guid vs link) and
   de-duplication; HTML sanitising of entry content (where and when — at
   ingest or at render).
6. **Source plugins for non-RSS sites.** The plugin interface (in TypeScript,
   in the Next.js app), how a plugin is registered and how a feed row points
   at one, and how claude-code and cursor are rewritten as the first two.
   **Whether a headless browser is needed at all in v1**: check both sites
   today with a plain fetch and say what you found.
7. **The old public Atom output** (`/:namespace/:route`): options for the
   owner (drop it; keep it for built-in sources; a per-user/per-feed Atom
   export behind an API key), with the cost of each. Do not decide.
8. Fetch hygiene: timeouts, user agent, response size cap, redirects,
   SSRF (a user-supplied URL fetched from our function).

### interface (`drafts/interface.md`)

1. Describe the screens (sign-in, sign-up when on, the reader, add feed,
   feed settings/remove, API keys, admin if any), each with its states:
   empty, loading, error,
   a failing feed, registration off.
2. The keys (j/k, o/enter, m, shift+a, r, ?, …) and how they are shown.
3. The sentences: every label, empty state, error and confirmation text.
4. Routes and server actions the screens need, and which are server
   components vs client components. What the reader's first paint costs on a
   cold start.
5. Which shadcn/ui components are used as they are; anything not covered by
   shadcn/ui goes up as a question.
6. Mobile/narrow layout: what it is, kept minimal.

### state (`drafts/state.md`)

1. **Single vs multi-user data model** given registration can be on:
   shared `Feed` rows with per-user `Subscription` and per-user read state,
   or everything per user. What the admin may do that others may not.
2. **The Prisma schema** in full: better-auth's tables (user, session,
   account, verification, apikey) and ours (feed, entry, subscription,
   read state), indexes, cascades, retention of old entries.
3. **Prisma on Neon**: the driver adapter (`@prisma/adapter-neon`) and the
   client setup for serverless; migrations (who runs `prisma migrate deploy`
   and when); the local stack (docker compose Postgres on a non-default port,
   the dev server port, `.env.example`), and how the same code talks to plain
   local Postgres and to Neon.
4. **Auth and API keys**: better-auth setup with the admin email and the
   registration switch (where each is enforced), the API key plugin, what an
   API key may reach (read entries? mark read? add feeds? admin?), rate
   limits, and the API's routes and response shapes.
5. **Caching**: whether anything beyond Postgres and Next.js's own caching
   is needed (the answer should be no unless shown otherwise).
6. **The test plan**: runner (bun test or vitest — say why), unit tests for
   parsers and plugins with fixtures, integration tests against the docker
   Postgres, how the queue consumer and cron fan-out are tested, and what CI
   runs. No test touches Neon or Vercel.

### Shared

- The order of build units for the ship team, the first being: remove Deno,
  init Next.js with the preset, docker compose, Prisma, auth.
- Every draft ends with a list: decisions made, questions for the owner,
  questions for another architect.

## Rules for drafts

- Write and commit only your own draft (`git add <your files>`, signed
  commit, `docs: …`, no trailers, no push). Do not touch code or other
  drafts.
- No deploys, no `vercel link`/`vercel env pull`, no Neon, no real queue, no
  secrets written anywhere. A dev server, if any, on its own port, stopped
  when done.
- Cite the doc or source (URL, package version) for every claim about what a
  library or Vercel does today.
