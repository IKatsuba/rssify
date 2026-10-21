# RSS-1 state draft: data model, storage, auth, tests

State architect's answers to the brief's state questions 1–6 and the shared
items, with the owner's settled answers folded in (Vercel Pro, multi-user,
Sign in with Vercel). The rule throughout: as simple as possible.

Versions checked on 2026-10-21 against the npm registry and package source:

| Package | Version | Note |
| --- | --- | --- |
| `better-auth` | 1.7.12 | core, includes `better-auth/adapters/prisma` |
| `@better-auth/api-key` | 1.7.12 | the API key plugin is its own package in 1.7 |
| `@prisma/client`, `prisma` | 7.10.1 | npm `latest` is `8.0.0-rc.24`, an RC; pin 7.10.1 (`prev`, the last stable) |
| `@prisma/adapter-neon` | 7.10.1 | |
| `@prisma/adapter-pg` | 7.10.1 | local Postgres and tests |
| `@neondatabase/serverless` | 1.2.0 | pulled in by the Neon adapter |
| `next` | 16.4.2 | |

## 1. Data model: shared feeds, per-user subscriptions and read state

Options:

- **A. Everything per user** (each user's own `Feed` and `Entry` rows). It
  is simple to query, but the same URL is fetched once per subscriber and the
  entries are stored once per subscriber.
- **B. Shared `Feed` and `Entry`, per-user `Subscription` and `ReadMark`.**
  Each URL is fetched once, whoever subscribes. Read state is the only
  per-user data about entries.

**Chosen: B.** It costs one join more than A and saves a fetch and a copy
of every entry per extra subscriber. It also fits the brief's shape: one
queue message per due feed, not one per subscription.

- `Feed` is keyed by its normalised URL (`url` unique). A built-in source is
  a `Feed` with `pluginId` set and `url` = the site's list page (e.g.
  `https://claude.com/blog`). It is created on first subscribe, so there is
  no seeding.
- `Entry` belongs to a feed and is unique on `(feedId, guid)`, where `guid`
  is the identity key ingest computes.
- `Subscription` is unique on `(userId, feedId)`.
- `ReadMark` is one row per (user, entry) the user has read. No row means
  unread. Mark-unread deletes the row. A user who subscribes to a feed that
  already has entries sees the kept ones as unread, as most readers do.
- When a user unsubscribes, only the `Subscription` row goes. Their
  `ReadMark` rows stay, so if they come back their read state is still
  there. A feed that nobody follows stays in the table, but the fan-out
  skips it (it selects only feeds with at least one subscription).
  Retention (§2) keeps it small.

**Admin.** `isAdmin` is not stored. It is computed: the session user's
`email` equals `ADMIN_EMAIL` (compared case-insensitively) and
`emailVerified` is true. better-auth's `admin` plugin is not used: it adds
role, ban and impersonation columns we don't need. The admin can do only
these things beyond a user:

1. Sign in when registration is off, which bootstraps the first account
   (§4).
2. See `/admin`: the users (email, created, number of subscriptions) and
   all feeds (URL, number of subscribers, `failureCount`, `lastError`,
   `lastSuccessAt`, `nextPollAt`).
3. Delete a user. Their sessions, accounts, API keys, subscriptions and
   read marks are deleted with them by cascade.

The admin gets nothing else: no editing of feeds, no reading other users'
read state, no impersonation. An API key never carries admin rights, even
one the admin made (§4).

## 2. Prisma schema (complete)

`prisma/schema.prisma`. The better-auth models match the fields that
better-auth 1.7.12 declares:

- the core tables in `@better-auth/core` `dist/db/get-tables.mjs` (user,
  session, account, verification);
- the API key table in `@better-auth/api-key` `dist/index.mjs`
  (`apiKeySchema`).

Docs: https://www.better-auth.com/docs/concepts/database#core-schema,
https://www.better-auth.com/docs/plugins/api-key#schema,
https://www.better-auth.com/docs/adapters/prisma.

The ship team generates the auth part with
`bunx @better-auth/cli generate` and compares it with this file. If they
differ, the CLI output wins for the auth models. Our own models are as
below.

```prisma
generator client {
  provider = "prisma-client"
  output   = "../lib/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

// ---------- better-auth 1.7.12 core ----------

model User {
  id            String   @id
  name          String
  email         String   @unique
  emailVerified Boolean  @default(false)
  image         String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @default(now()) @updatedAt

  sessions      Session[]
  accounts      Account[]
  apikeys       Apikey[]
  subscriptions Subscription[]
  readMarks     ReadMark[]

  @@map("user")
}

model Session {
  id        String   @id
  expiresAt DateTime
  token     String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  ipAddress String?
  userAgent String?
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("session")
}

model Account {
  id                    String    @id
  accountId             String
  providerId            String
  userId                String
  user                  User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  accessToken           String?
  refreshToken          String?
  idToken               String?
  accessTokenExpiresAt  DateTime?
  refreshTokenExpiresAt DateTime?
  scope                 String?
  password              String?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  @@index([userId])
  @@map("account")
}

model Verification {
  id         String   @id
  identifier String
  value      String
  expiresAt  DateTime
  createdAt  DateTime @default(now())
  updatedAt  DateTime @default(now()) @updatedAt

  @@index([identifier])
  @@map("verification")
}

// ---------- @better-auth/api-key 1.7.12 ----------
// The plugin declares referenceId as a plain indexed string. The relation
// below is ours: it adds an FK so that deleting a user deletes their keys.
// better-auth only reads and writes the column, so the FK changes nothing
// for it.

model Apikey {
  id                  String    @id
  configId            String    @default("default")
  name                String?
  start               String?
  referenceId         String
  user                User      @relation(fields: [referenceId], references: [id], onDelete: Cascade)
  prefix              String?
  key                 String
  refillInterval      Int?
  refillAmount        Int?
  lastRefillAt        DateTime?
  enabled             Boolean?  @default(true)
  rateLimitEnabled    Boolean?  @default(true)
  rateLimitTimeWindow Int?      @default(60000)
  rateLimitMax        Int?      @default(120)
  requestCount        Int?      @default(0)
  remaining           Int?
  lastRequest         DateTime?
  expiresAt           DateTime?
  createdAt           DateTime
  updatedAt           DateTime
  permissions         String?
  metadata            String?

  @@index([configId])
  @@index([referenceId])
  @@index([key])
  @@map("apikey")
}

// ---------- rssify ----------

model Feed {
  id        String  @id @default(cuid())
  url       String  @unique // normalised feed URL, or list-page URL for a plugin feed
  pluginId  String? // null = RSS/Atom/JSON Feed; else a registered source plugin id (ingest)
  title     String? // from the feed; null until the first successful poll
  siteUrl   String?

  // Polling fields: ingest owns their meaning. Needs ingest's agreement.
  nextPollAt    DateTime  @default(now()) // due when <= now()
  lastPolledAt  DateTime?
  lastSuccessAt DateTime?
  etag          String?
  lastModified  String? // raw Last-Modified header, sent back verbatim
  failureCount  Int       @default(0) // consecutive failures; 0 after a success
  lastError     String? // short message shown to subscribers, null when healthy

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  entries       Entry[]
  subscriptions Subscription[]

  @@index([nextPollAt])
}

model Entry {
  id          String    @id @default(cuid())
  feedId      String
  feed        Feed      @relation(fields: [feedId], references: [id], onDelete: Cascade)
  guid        String // identity within the feed, computed by ingest
  url         String?
  title       String
  author      String?
  summary     String?
  content     String? // in the one format ingest settles on (sanitised HTML or Markdown)
  publishedAt DateTime? // as the source states it, may be null
  sortAt      DateTime // publishedAt ?? createdAt, clamped to <= createdAt; the one sort key
  createdAt   DateTime  @default(now()) // when we stored it

  readMarks ReadMark[]

  @@unique([feedId, guid])
  @@index([feedId, sortAt(sort: Desc), id(sort: Desc)])
  @@index([sortAt(sort: Desc), id(sort: Desc)])
}

model Subscription {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  feedId    String
  feed      Feed     @relation(fields: [feedId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now())

  @@unique([userId, feedId])
  @@index([feedId])
}

model ReadMark {
  userId  String
  user    User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  entryId String
  entry   Entry    @relation(fields: [entryId], references: [id], onDelete: Cascade)
  readAt  DateTime @default(now())

  @@id([userId, entryId])
  @@index([entryId])
}
```

Notes:

- In Prisma 7 the schema has no `url`. The connection lives in
  `prisma.config.ts` for the CLI and in the driver adapter at runtime, and
  the generator is `prisma-client` with a required `output`
  (https://www.prisma.io/docs/orm/reference/prisma-config-reference,
  https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7).
- `Apikey` rate-limit defaults are 60 000 ms / 120 requests. The plugin's
  own defaults are 1 day / 10 requests (`@better-auth/api-key` 1.7.12
  `dist/index.mjs`, `rateLimit.timeWindow ?? 864e5`,
  `maxRequests ?? 10`), which is unusable for a reader client. The values
  are set in the plugin config (§4); the column defaults only mirror them.
- **Sort and pagination.** The list is ordered by `(sortAt desc, id desc)`
  and paged with a keyset cursor `(sortAt, id)`. `sortAt` is clamped so
  that a future-dated entry cannot sit at the top for ever.
- **Unread count per subscription.** One grouped query, served by
  `Entry(feedId, sortAt, id)` and `ReadMark` PK:
  `count(e) where e.feedId in my feeds and not exists ReadMark(me, e.id)`.

**Retention.** Each feed keeps its newest `ENTRY_KEEP_PER_FEED = 500`
entries by `(sortAt, id)`. This is a constant in `lib/`, not an env
variable.

- The prune runs at the end of the consumer for that one feed, inside the
  same claimed refresh (§3), in one `DELETE … WHERE id IN (SELECT … OFFSET
  500)`. There is no separate cleanup cron.
- Pruning by count, not by age, avoids "resurrection". A source feed
  usually lists 10–50 items, so an entry past position 500 is no longer in
  the source and cannot come back as new and unread. For this to hold,
  ingest stores at most the newest 500 items of one poll.
- `ReadMark` rows go with their entry by cascade.
- Orphan feeds (no subscribers) are not polled. They keep at most 500
  entries. Deleting them is listed for later.

## 3. Prisma on Neon, migrations, local stack

**Client.** `lib/db.ts` holds one `PrismaClient` per function instance,
cached on `globalThis` so that dev hot reload does not make new ones. The
adapter is picked by the URL's host:

```ts
import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/lib/generated/prisma/client';

function makeClient() {
  const connectionString = process.env.DATABASE_URL!;
  const isNeon = new URL(connectionString).hostname.endsWith('.neon.tech');
  const adapter = isNeon
    ? new PrismaNeon({ connectionString })
    : new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

const g = globalThis as unknown as { prisma?: PrismaClient };
export const db = g.prisma ?? (g.prisma = makeClient());
```

- `PrismaNeon({ connectionString })` is the 7.x constructor
  (`@prisma/adapter-neon` 7.10.1 README).
- The adapter's README adds `neonConfig.webSocketConstructor = ws` for
  runtimes without a global `WebSocket`. Vercel's Node 22/24 runtimes have
  one, so `ws` is not added unless a build fails without it.
- Options for local Postgres were (a) `PrismaPg` locally and in tests,
  `PrismaNeon` on Vercel, or (b) Neon's local WebSocket proxy container,
  so that `PrismaNeon` runs everywhere. **Chosen: (a).** There is no extra
  container, and the code path differs only in this one constructor.
- Prisma 7's client has no Rust query engine
  (https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7).
  That keeps the function bundle small and helps cold starts.

**`prisma.config.ts`** sets `schema: 'prisma/schema.prisma'`,
`migrations.path: 'prisma/migrations'` and
`datasource.url: env('DATABASE_URL_UNPOOLED') ?? env('DATABASE_URL')`.
Migrations need the direct (unpooled) Neon URL; at runtime the app uses
`DATABASE_URL`, the pooled one.

**Migrations.**

- Developers run `bunx prisma migrate dev` against the docker database
  and commit the files in `prisma/migrations/`.
- Production runs `prisma migrate deploy` in the Vercel build. The build
  command is `bun run vercel-build`:
  `prisma generate && (test "$VERCEL_ENV" = production && prisma migrate deploy || true) && next build`.
  Only production builds migrate.
- Preview deployments are an owner question (see the end).
- Every v1 migration is additive, which is what keeps records from an
  older build safe (below).

**Records an older build wrote, and an older build running beside a newer
one.**

- During a rollout, old functions keep running against the migrated
  schema. That is safe because migrations only add: new columns are
  nullable or have a default, and Prisma selects columns by name, so extra
  columns are ignored.
- Renaming or dropping a column takes two releases: first stop using it,
  then drop it.
- An entry an older build stored keeps whatever `content` it was given. If
  ingest changes its sanitiser, old rows are not rewritten; a later
  re-sanitise is a one-off script, not a v1 concern.
- A queue message an older build sent carries `{ v: 1, feedId }` (ingest's
  shape, to agree). The consumer ignores unknown fields. A message whose
  feed no longer exists is acked and dropped.
- A session or API key that an older better-auth wrote is read by the
  same adapter. A better-auth upgrade that changes the tables comes with
  a Prisma migration generated by its CLI.

**Local stack.**

- Postgres 17 in docker compose on host port **54329**, dev database
  `rssify`, test database `rssify_test`. The container trusts local
  connections (`POSTGRES_HOST_AUTH_METHOD=trust`), so no password is
  written anywhere.
- The Next.js dev server runs on **3210**: `"dev": "next dev -p 3210"`.

`docker-compose.yml` (replaces the current app + Redis file):

```yaml
services:
  postgres:
    image: postgres:17-alpine
    ports:
      - '54329:5432'
    environment:
      POSTGRES_USER: rssify
      POSTGRES_DB: rssify
      POSTGRES_HOST_AUTH_METHOD: trust
    volumes:
      - pg-data:/var/lib/postgresql/data
      - ./docker/postgres-init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ['CMD', 'pg_isready', '-U', 'rssify']
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  pg-data:
```

`docker/postgres-init.sql` is one line: `CREATE DATABASE rssify_test;`.

**`.env.example`.** Names, with defaults only where the value is not a
secret:

| Name | Default / example | Used by |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://rssify@localhost:54329/rssify` | runtime; on Vercel the Neon pooled URL |
| `DATABASE_URL_UNPOOLED` | unset (falls back to `DATABASE_URL`) | `prisma migrate`; on Vercel the Neon direct URL |
| `TEST_DATABASE_URL` | `postgresql://rssify@localhost:54329/rssify_test` | tests only |
| `BETTER_AUTH_SECRET` | empty, must be set (`openssl rand -base64 32`) | better-auth |
| `BETTER_AUTH_URL` | `http://localhost:3210` | better-auth base URL and OAuth callback |
| `VERCEL_CLIENT_ID` | empty | Sign in with Vercel |
| `VERCEL_CLIENT_SECRET` | empty | Sign in with Vercel |
| `ADMIN_EMAIL` | empty (no admin) | §1, §4 |
| `REGISTRATION_ENABLED` | `false` (only the exact string `true` opens it) | §4 |
| `CRON_SECRET` | empty | Vercel Cron auth (ingest owns the route) |

Any queue variables are ingest's to add. The names `DATABASE_URL` and
`DATABASE_URL_UNPOOLED` match what the Neon–Vercel integration sets
(https://neon.com/docs/guides/vercel-managed-integration).

## 4. Auth and API keys

**Sign in with Vercel.** better-auth 1.7.12 has a **built-in** `vercel`
social provider, so the generic OAuth plugin is not needed:

- source: `@better-auth/core` `dist/social-providers/vercel.mjs`;
- docs: https://www.better-auth.com/docs/authentication/vercel.

What the provider does:

- authorize `https://vercel.com/oauth/authorize`, PKCE required;
- token `https://api.vercel.com/login/oauth/token`;
- user info `https://api.vercel.com/login/oauth/userinfo`;
- maps `email`, `name` (or `preferred_username`), `picture`, and
  `emailVerified = profile.email_verified ?? false`.

Its env variables are `VERCEL_CLIENT_ID` and `VERCEL_CLIENT_SECRET`, from
a Vercel App (https://vercel.com/docs/sign-in-with-vercel). The App's
scopes are `openid email profile`. The docs say scopes are set on the App,
so the provider takes no `scope`. The callback URL is
`<BETTER_AUTH_URL>/api/auth/callback/vercel`.

**Locally:** the owner registers a second Vercel App for development, with
the callback `http://localhost:3210/api/auth/callback/vercel`, and puts
its id and secret in `.env.local`. A separate dev App means we don't need
to know whether one App may hold several callback URLs (not verified), and
production credentials never sit on a laptop.

There is no email/password: `emailAndPassword` stays unset. Nothing in v1
needs it. The first account is the admin's, through Vercel (below), and
tests create users directly in the database (§6).

`lib/auth.ts`:

```ts
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { nextCookies } from 'better-auth/next-js';
import { apiKey } from '@better-auth/api-key';
import { db } from '@/lib/db';

const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase() || null;
const registrationOpen = process.env.REGISTRATION_ENABLED === 'true';

export const auth = betterAuth({
  database: prismaAdapter(db, { provider: 'postgresql' }),
  socialProviders: {
    vercel: {
      clientId: process.env.VERCEL_CLIENT_ID!,
      clientSecret: process.env.VERCEL_CLIENT_SECRET!,
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (registrationOpen) return;
          if (adminEmail && user.email === adminEmail && user.emailVerified) return;
          throw new APIError('FORBIDDEN', {
            code: 'signup_disabled',
            message: 'Registration is closed.',
          });
        },
      },
    },
  },
  plugins: [
    apiKey({
      defaultPrefix: 'rss_',
      rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 },
    }),
    nextCookies(),
  ],
});

export function isAdmin(user: { email: string; emailVerified: boolean }) {
  return !!adminEmail && user.email.toLowerCase() === adminEmail && user.emailVerified;
}
```

**Where the registration switch is enforced: `databaseHooks.user.create.before`.**
It runs on every user creation, from any path. When registration is closed
it lets through only the verified admin email.

- Why not the provider's `disableSignUp`: that option exists, but it would
  also shut out the admin when registration is off. That makes the first
  sign-in of a fresh deploy impossible.
- Source for the behaviour, better-auth 1.7.12 `dist/oauth2/link-account.mjs`:
  the user is created inside a `try`, and an `APIError` from the hook is
  re-thrown.
- `dist/api/routes/callback.mjs` then catches it and calls
  `redirectOnError(e.body.code)`. The browser lands on the
  `errorCallbackURL` the sign-in button passed, with
  `?error=signup_disabled`, and interface shows its "registration closed"
  state from that.
- An existing user is not created again, so closing registration never
  locks out people who already have accounts.

**Where the admin is enforced:**

- `isAdmin()` in `lib/auth.ts`, called by `requireAdmin()`, which guards
  `/admin` (a server component layout) and each admin server action.
- `emailVerified` must be true. Vercel's `email_verified` claim is mapped
  by the provider; without that check, an unverified Vercel email equal to
  `ADMIN_EMAIL` would be admin.
- Admin rights are checked against the env on every request and never
  stored, so changing `ADMIN_EMAIL` takes effect on the next deploy.

**Who is calling.** `lib/actor.ts` exports
`getActor(headers): { userId, via: 'session' | 'apiKey', isAdmin }`.

- If the `x-api-key` header is present, it calls
  `auth.api.verifyApiKey({ body: { key } })`. That checks enabled, expiry
  and the rate limit and counts the request. The result is
  `{ userId: key.referenceId, via: 'apiKey', isAdmin: false }`.
- Otherwise it calls `auth.api.getSession({ headers })`.
- `enableSessionForAPIKeys` stays `false` (its default), so an API key is
  never accepted as a session by server actions, admin pages, or
  better-auth's own key-management endpoints.

**What an API key reaches.** Everything its owner can do as a reader in
`/api/v1`, and nothing else:

| | Session (UI) | API key |
| --- | --- | --- |
| list subscriptions, unread counts | yes | yes |
| list and read entries | yes | yes |
| mark read, unread, all read | yes | yes |
| add and remove a subscription | yes | yes |
| create, list and revoke API keys | yes | **no** (better-auth endpoints need a session) |
| admin | admin only | **no**, even the admin's keys |

All keys carry the same rights in v1. Read-only keys (the plugin's
`permissions`) are listed for later.

**Rate limits.**

- API keys: 120 requests per minute per key, kept by the plugin in the
  `apikey` row. That costs one row update per API call, which is fine at
  this scale.
- better-auth's own limiter is left at its default (on in production,
  memory storage). On serverless that means per instance, which is weak,
  but the only public auth endpoints are the OAuth redirect and callback.
  No `rateLimit` table.

**API routes.** These are Route Handlers under `app/api/v1/`. Each is a
thin wrapper over `lib/reader.ts`; the UI's server actions call the same
functions. JSON throughout. Errors are
`{ "error": { "code": string, "message": string } }`, with status 400,
401, 403, 404, 409, 422 or 429.

- `GET /api/v1/subscriptions` →
  `{ subscriptions: [{ id, createdAt, unreadCount, feed: { id, url, title, siteUrl, pluginId, failing: boolean, lastError, lastSuccessAt } }] }`.
  `failing` is `failureCount >= 3`, a threshold to agree with ingest.
- `POST /api/v1/subscriptions`, body `{ url }` or `{ source: '<pluginId>' }`
  → `201 { subscription }`. Subscribing again to the same feed returns
  `200` with the existing subscription. Discovery failures give `422`
  (ingest's error codes).
- `DELETE /api/v1/subscriptions/:id` → `204`.
- `GET /api/v1/entries?feedId=&unread=true&limit=50&cursor=` →
  `{ entries: [{ id, feedId, title, url, author, summary, publishedAt, sortAt, read }], nextCursor: string | null, asOf: ISO }`.
  `limit` is at most 100.
- `GET /api/v1/entries/:id` → `{ entry: { …the above, content } }`.
- `PUT /api/v1/entries/:id/read` → `204`; `DELETE /api/v1/entries/:id/read` → `204`.
- `POST /api/v1/entries/read`, body `{ feedId?: string, upTo: ISO }` →
  `{ marked: number }` (mark all read, §3a).

A user only reaches entries of feeds they subscribe to. Any other
`entryId` or `feedId` gives `404`, never `403`, so the API does not reveal
what exists.

### 3a. Races and failures, with the expected outcome

| Case | What happens |
| --- | --- |
| Two refreshes of one feed at once (cron and queue redelivery, or two fan-outs) | The consumer claims the feed first: `UPDATE feed SET nextPollAt = now() + interval '5 minutes' WHERE id = $1 AND nextPollAt <= now()`. With 0 rows updated it acks and exits. If both get through anyway (a lease expiry), entries go in with `createMany({ skipDuplicates: true })` on `(feedId, guid)`, so there are no duplicates. The feed's poll fields are last writer wins, and both write a valid state. The claim is ingest's to confirm. |
| A source re-sends an entry with changed text | First version wins: no update on conflict. Ingest may want an update; question for ingest. |
| Mark-read during a refresh | Independent rows; nothing conflicts. A new entry arrives unread. |
| Mark all read while new entries land | Only entries in scope with `createdAt <= upTo` are marked. `upTo` is the `asOf` the client got with the list, so entries that arrived after the user looked stay unread. It is one `INSERT … SELECT … ON CONFLICT DO NOTHING`. |
| The same entry marked read twice (two tabs, a double key press) | `ON CONFLICT DO NOTHING` (`skipDuplicates`). Mark-unread is `deleteMany`, so a second one does nothing. Both are idempotent and return `204`. |
| Marking an entry read just as retention deletes it | FK violation (`P2003`), turned into `404`. |
| Reading an entry that retention deleted | `404`. Interface shows "This entry is no longer kept". |
| Two users add the same new URL at once | The feed is created with `INSERT … ON CONFLICT (url) DO NOTHING`, then read back, so both get the same row. Each user's subscription is unique on `(userId, feedId)`. |
| One user adds the same URL twice at once | The second insert hits `P2002` on `(userId, feedId)` and returns the existing subscription (`200`). |
| Unsubscribe during a refresh | The refresh finishes; entries still land on the shared feed. If it was the last subscriber, the next fan-out skips the feed. |
| A user is deleted (by the admin) | Sessions, accounts, API keys, subscriptions and read marks go by cascade. Feeds and entries stay. |
| The consumer crashes mid-refresh | Entries already inserted stay, and duplicates can't happen. The claim lease runs out and the feed is due again. `failureCount` is unchanged, because a crash is not counted, only fetch and parse errors. |
| An API key is revoked or expired mid-use | The next call gets `401`. |
| The rate limit is hit | `429`, with the plugin's `tryAgainIn` turned into a `Retry-After` header. |
| Registration is closed and a new Vercel account signs in | Redirect to `/sign-in?error=signup_disabled`. No user or account row is written: the hook throws before the transaction commits. |
| `ADMIN_EMAIL` is unset | There is no admin. With registration closed, nobody new can sign up; that is a valid locked state. |
| Database unreachable | Pages render the error boundary. The consumer throws and the queue retries (ingest). Nothing degrades silently. |

## 5. Caching

**None beyond Postgres.**

- Every reader page depends on the session cookie, so it is rendered
  dynamically. Unread counts and lists are one or two indexed queries.
- `React.cache` dedupes `getActor` within one request.
- There is no `use cache`, no `unstable_cache` and no Redis. After a
  server action changes something, `revalidatePath('/')` refreshes the
  rendered view.
- Conditional GETs (ETag, Last-Modified) are the only "cache" in ingest,
  and they live on the `Feed` row.
- The old per-post 7-day Redis cache is not needed. Each entry is stored
  once and never fetched again.

## 6. Test plan

**Runner: `bun test`.** It is built in, so there is no added dependency,
and the owner already uses bun. It runs TypeScript directly and runs test
files one after another by default, which suits one shared test database.

- vitest would add a dependency and a config file for nothing v1 needs.
  There are no component tests; screens are checked by hand.
- Risk: a module that imports `server-only` throws outside Next.js. Keep
  `server-only` in `app/` entry files, not in `lib/`, or alias it to an
  empty module in `bunfig.toml`. Bun docs: https://bun.sh/docs/cli/test.

**Database for tests.**

- `TEST_DATABASE_URL` points at `rssify_test` in the compose Postgres.
- `bun run test` is
  `DATABASE_URL=$TEST_DATABASE_URL prisma migrate deploy && DATABASE_URL=$TEST_DATABASE_URL bun test`.
- A `beforeEach` in `test/db.ts` truncates every table
  (`TRUNCATE … RESTART IDENTITY CASCADE`).
- Users are inserted straight into `user`, without OAuth. API keys are made
  with `auth.api.createApiKey({ body: { userId } })`, the server-side form
  that needs no session.
- No test touches Neon, Vercel, the queue or the network. HTTP is stubbed
  by passing a `fetch` into ingest's functions; how is ingest's choice.

**Tests in `lib/`, by file and case.**

`lib/reader.test.ts`, against the database:

- subscribe by URL creates the feed and the subscription;
- subscribe again is idempotent and returns the existing subscription;
- two users subscribing to one URL share one `Feed`;
- two concurrent subscribes (`Promise.all`) give one feed and one
  subscription each;
- unsubscribe removes only the subscription; feed, entries and read marks
  stay;
- the unread count per subscription is correct with mixed read state;
- entries are listed newest first by `(sortAt, id)`, and the keyset cursor
  pages without gaps or repeats when two entries share a `sortAt`;
- the `unread=true` filter;
- a feed the user is not subscribed to gives `404` for list, read and mark;
- mark read is idempotent;
- mark unread is idempotent;
- mark all read respects `upTo`, so an entry created after `asOf` stays
  unread;
- mark all read for one feed leaves other feeds alone;
- marking an entry deleted by retention gives `404`, not a 500.

`lib/retention.test.ts`:

- a feed with 520 entries keeps the newest 500;
- read marks of pruned entries are gone;
- other feeds are untouched.

`lib/feeds-store.test.ts` (the storage half of the consumer; ingest's
parsing tests sit beside it):

- inserting the same items twice gives no duplicates (`skipDuplicates` on
  `(feedId, guid)`);
- two concurrent inserts of overlapping batches give the union with no
  duplicates;
- the claim lets only one of two concurrent claims through;
- a claim on a not-yet-due feed is refused;
- success resets `failureCount` and `lastError`;
- failure increments them;
- `sortAt` falls back to `createdAt` when `publishedAt` is null, and a
  future `publishedAt` is clamped.

`lib/auth.test.ts`:

- `isAdmin` is true only for a verified email equal to `ADMIN_EMAIL`, case
  ignored;
- false when `ADMIN_EMAIL` is unset;
- the `user.create.before` hook:
  - registration open allows anyone;
  - closed throws `signup_disabled`;
  - closed lets the verified admin through;
  - closed refuses the admin email when it is unverified.
- Each case calls the exported hook function, with the env read through a
  small `authConfig()` so tests can set it.

`lib/actor.test.ts`:

- a valid API key resolves to its owner with `isAdmin: false`, even for
  the admin's own key;
- a revoked key gives 401;
- an expired key gives 401;
- the 121st call within a minute gives 429;
- no header and no session gives 401.

`app/api/v1/*.test.ts`:

- one smoke test per route, calling the exported `GET`/`POST` handler with
  a `Request` that carries `x-api-key`;
- checks status and response shape, including the error shape.

Fan-out and consumer: their handlers are called directly, as plain
functions over the database (ingest's seam):

- fan-out picks only due feeds with at least one subscription;
- the consumer of a deleted feed acks;
- an end-to-end run from a fixture feed to entries in the database.

**CI** (GitHub Actions; owner to confirm that CI is wanted at all):

- one job with a `postgres:17-alpine` service on 54329;
- steps: `bun install`, `bunx prisma generate`, `bun run lint`,
  `bunx tsc --noEmit`, `bun run test`, `bun run build`;
- no Vercel or Neon secrets in CI. The build only needs dummy env values,
  because nothing connects at build time.

**By hand only, on the local dev server** (`docker compose up -d`,
`bunx prisma migrate dev`, `bun run dev`, open http://localhost:3210):

1. Sign in with Vercel through the dev Vercel App. You land on the reader,
   and a `user` and an `account` row exist.
2. With `REGISTRATION_ENABLED=false` and an `ADMIN_EMAIL` that is not
   yours: sign out, sign in with a fresh Vercel account, and you see the
   "registration closed" state. Then set `ADMIN_EMAIL` to that account's
   email, restart, and sign-in works.
3. As admin: `/admin` lists users and feeds. Deleting a user removes their
   rows. As a non-admin, `/admin` gives 404.
4. Create an API key in the UI and copy it. Then
   `curl -H 'x-api-key: …' localhost:3210/api/v1/subscriptions` returns
   JSON. Revoke the key, and the same call gives 401.
5. Subscribe to a real RSS URL and to both built-in sources. Run the
   consumer locally (ingest's local trigger) and watch entries appear.
6. Read, mark unread, mark all read, and the keys. Open two tabs and mark
   in one, then reload the other.

## Build units (order for the ship team)

1. **Foundation.** Remove the Deno files (`main.ts`, `main_test.ts`,
   `lib/`, `providers/`, `deno.json`, `deno.lock`, `Dockerfile`, the old
   compose file). Init Next.js with
   `bunx --bun shadcn@latest init --preset b1D0dxmC --template next --pointer`
   and set the dev port to 3210. Add the new `docker-compose.yml` and
   `docker/postgres-init.sql`, `.env.example`, Prisma 7 with
   `prisma.config.ts`, `lib/db.ts` and the full schema with the first
   migration. Add better-auth with the Vercel provider, the hook,
   `isAdmin`, the API key plugin and `app/api/auth/[...all]/route.ts`.
   Add a bare sign-in page and a signed-in placeholder. Add `bun test` with
   `test/db.ts` and `lib/auth.test.ts`. Update CLAUDE.md.
2. **Reader core in `lib/`:** `reader.ts` (subscribe, unsubscribe, list,
   read, mark), `actor.ts` and retention, with their tests. No UI.
3. **Ingest:** parser, discovery, the two plugins, the consumer's storage
   half, fan-out, cron and the queue wiring (ingest's units).
4. **Reader UI** (interface's units), on the server actions over
   `lib/reader.ts`.
5. **API keys UI and `/api/v1`** route handlers, with smoke tests.
6. **Admin page.**
7. **CI workflow.**

## Decisions made

- Shared `Feed`/`Entry`; per-user `Subscription` and `ReadMark` (a row per
  read entry).
- The admin is computed from `ADMIN_EMAIL` and a verified email, never
  stored. Admin powers: bootstrap sign-in, `/admin` lists, delete a user.
  No better-auth admin plugin.
- Sign in with Vercel through better-auth 1.7.12's built-in `vercel`
  provider. No email/password.
- The registration switch is enforced in `databaseHooks.user.create.before`,
  with the admin exempt. Its error is `signup_disabled`.
- `@better-auth/api-key` with prefix `rss_` and 120 requests per minute.
  Keys reach the reader API only: never key management, never admin.
  Identity comes from `verifyApiKey`, not `enableSessionForAPIKeys`.
- Prisma 7.10.1 (not the 8.0 RC). `PrismaNeon` on Neon, `PrismaPg`
  locally, chosen by host. One client per instance.
- `prisma migrate deploy` runs in the production Vercel build only.
  Migrations are additive.
- Retention is the newest 500 entries per feed, pruned by the consumer.
- No cache beyond Postgres.
- Postgres on 54329 with trust auth locally; dev server on 3210; test
  database `rssify_test` in the same container.
- `bun test`, against the docker database, with handlers called directly.

## Questions for the owner

1. **Preview deployments and the database.** Options:
   - (a) Neon's Vercel integration gives each preview its own Neon branch,
     and every build migrates its own branch. This is the safe one; it
     costs Neon branch usage.
   - (b) Previews share production's database and do not migrate. That is
     unsafe as soon as a preview carries a new migration.
   - (c) No database for previews (they build only).

   Recommended: (a). Sign-in on previews also needs better-auth's
   `oAuthProxy` plugin or a Vercel App per preview URL; recommended: no
   sign-in on previews in v1.
2. **Two Vercel Apps** (dev with the localhost callback, prod) for Sign in
   with Vercel: OK? The owner creates them and holds the secrets.
3. **CI on GitHub Actions** as in §6: wanted in v1?
4. **Retention of 500 entries per feed:** the right number?

## Questions for ingest

1. Polling fields on `Feed` (`nextPollAt`, `lastPolledAt`, `lastSuccessAt`,
   `etag`, `lastModified`, `failureCount`, `lastError`, `pluginId`): do you
   agree, or is something missing (e.g. a feed's own TTL)?
2. The claim (`UPDATE … WHERE nextPollAt <= now()` with a 5-minute lease):
   in the consumer, the fan-out, or both?
3. `guid`: your identity rule, and whether a changed entry should update
   the stored row (I've assumed first version wins).
4. `content`: one format, sanitised HTML or Markdown, sanitised at ingest
   (my preference: store it sanitised, and render as is).
5. At most 500 items stored per poll, to match retention.
6. The `failing` threshold for the UI: `failureCount >= 3`?
7. The queue message shape `{ v: 1, feedId }`, and the error codes from
   discovery for `POST /subscriptions` (`422`).

## Questions for interface

1. The list response carries `asOf`. Please send it back as `upTo` on
   "mark all read".
2. Sign-in passes `errorCallbackURL: '/sign-in'`. Show the "registration
   closed" state on `?error=signup_disabled`, and a generic error for any
   other `error`.
3. A deleted entry shows a 404 state ("This entry is no longer kept").
4. `/admin` gives 404 to non-admins, and there is no link to it for them.
5. The API keys screen: show `start` (the first 6 characters), name,
   created, last used (`lastRequest`) and expiry. Show the full key once, at
   creation.
