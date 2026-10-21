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

## 7. MCP

The owner's settled requirement: rssify is used three ways, all
first-class in v1: the web UI, the HTTP API (API key) and an MCP server.
This section is written against DESIGN.md (key-only `/api/v1`,
`Feed.status`, `nextFetchAt`, `contentHtml`, synchronous subscribe, orphan
feeds deleted on last unsubscribe).

Versions read on 2026-10-21 (npm registry, package tarballs):

| Package | Version | Role |
| --- | --- | --- |
| `@better-auth/mcp` | 1.7.12 | `mcp()` plugin, `requireMcpAuth` |
| `@better-auth/oauth-provider` | 1.7.12 | the OAuth 2.1 provider `mcp()` is built on (dependency of the above; also `oauthProviderClient`, well-known helpers) |
| `@better-auth/cimd` | 1.7.12 | Client ID Metadata Documents |
| `better-auth` | 1.7.12 | `jwt()` plugin (signing keys, `/jwks`) |
| `@modelcontextprotocol/server` | 2.3.1 | the official MCP TypeScript SDK v2: `McpServer`, `createMcpHandler` |
| `zod` | 4.6.7 | the SDK needs `^4.2.0` |
| `mcp-handler` (Vercel) | 2.3.0 | considered, not used (§7.2) |
| `@modelcontextprotocol/sdk` | 1.32.1 | the v1 SDK line, replaced by the v2 packages; not used |

The MCP spec revision is **2026-07-28**
(https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

### 7.1 Authorization: better-auth's MCP support today

**What replaced the legacy plugin.** `better-auth` 1.6.33 shipped
`better-auth/plugins` `mcp` and `oidc-provider` (both are in
`dist/plugins/` of 1.6.33). In 1.7.12 both are gone from `dist/plugins/`.
They are replaced by two packages:

- `@better-auth/oauth-provider`, an OAuth 2.1 / OIDC provider;
- `@better-auth/mcp`, whose `mcp()` *is* that provider, configured for MCP.

Sources: `@better-auth/mcp` 1.7.12 `README.md` and `dist/index.mjs`;
https://www.better-auth.com/docs/plugins/mcp;
https://www.better-auth.com/docs/plugins/oauth-provider. We use `mcp()`;
the docs say not to add a separate `oauthProvider()` beside it.

**How it implements MCP authorization** (`@better-auth/mcp` 1.7.12
`dist/index.mjs`, `@better-auth/core` 1.7.12 `dist/oauth2/verify.mjs`, the
two docs pages above):

| MCP requirement (2026-07-28) | How better-auth does it |
| --- | --- |
| Protected resource metadata (RFC 9728) | `mcp()`'s `onRequest` serves `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource<resource path>`: `{ resource, authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported, dpop_signing_alg_values_supported }`. OIDC scopes (`openid`, `profile`, `email`, `offline_access`) are filtered out of `scopes_supported`. |
| `WWW-Authenticate` on 401 | `requireMcpAuth` answers a JSON-RPC 401 whose header carries `resource_metadata="<origin>/.well-known/oauth-protected-resource<resource path>"` (`resource-challenge-*.mjs`). A token without a required scope gets a 403 `insufficient_scope` naming the scopes (step-up). |
| Authorization server metadata (RFC 8414) and OIDC discovery | The provider serves `{issuer}/.well-known/oauth-authorization-server`, `/.well-known/oauth-authorization-server/<issuer path>` and `{issuer}/.well-known/openid-configuration`. For routes the framework does not forward, it exports `oauthProviderAuthServerMetadata(auth)` and `oauthProviderOpenIdConfigMetadata(auth)`. |
| Client registration | **CIMD** through `cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' })`: the client's `client_id` is an HTTPS URL of its metadata document, fetched by `@better-auth/cimd/node`'s pinned-address, no-redirect transport. **DCR** (`/oauth2/register`) is off unless `allowDynamicClientRegistration` and `allowUnauthenticatedClientRegistration` are set; the spec marks DCR deprecated. |
| PKCE | Authorization code + PKCE, `code_challenge_methods_supported: ['S256']` (`oidcServerMetadata` type in `dist/index.d.mts`). |
| Resource indicators (RFC 8707), audience | `mcp({ resource })` adds the resource to `resources` and to every registered client. A token request carrying `resource` gets a **JWT** access token with `aud = resource`. |
| Token verification on the MCP route | `requireMcpAuth(auth, handler, { resource, requiredScopes })` verifies signature (JWKS), `iss`, `aud`, `exp` and requires an `azp` claim, enforces DPoP when the token is DPoP-bound, and hands the verified claims to the handler. No database round trip for a bearer token. |
| Refresh tokens | Opaque, stored, rotated; `mcp()` sets a 30 s reuse window so a retried refresh gets the same answer. Access token 1 h, refresh token 30 days (provider defaults, oauth-provider docs, "Expirations"). |
| Consent | The provider redirects to `consentPage` with a signed query. Our page checks it with `verifyOAuthQueryParams(query, (await auth.$context).secret)` and calls `authClient.oauth2.consent({ accept })`. |

**The JWKS is fetched over HTTP, from ourselves.** `requireMcpAuth`
passes `jwksUrl` as a string (default `<baseURL>/jwks`, i.e.
`<BETTER_AUTH_URL>/api/auth/jwks`), and `verify.mjs` fetches it with
`fetchRefusingRedirects` and caches it per instance for 5 minutes (kid
miss: one refetch, 30 s cooldown). So a cold instance makes one request
to its own deployment before its first MCP call. That is accepted: it
costs one small function invocation per instance per 5 minutes and needs
no code of ours. There is no option to pass the key set in-process to
`requireMcpAuth`.

**Configuration** (`lib/auth.ts`, added to DESIGN.md §9):

```ts
import { jwt } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';

const baseURL = process.env.BETTER_AUTH_URL!; // e.g. http://localhost:3210
export const MCP_RESOURCE = `${baseURL}/api/mcp`;
export const MCP_SCOPE = 'reader';

export const auth = betterAuth({
  // …everything in DESIGN.md §9…
  disabledPaths: ['/token'], // jwt()'s session → JWT endpoint; not needed (oauth-provider docs, Installation)
  plugins: [
    jwt(),
    mcp({
      loginPage: '/sign-in',
      consentPage: '/consent',
      resource: MCP_RESOURCE,
      scopes: ['openid', 'profile', 'email', 'offline_access', MCP_SCOPE],
      // Prisma on Postgres cannot store a resource without allowedScopes
      // (oauth-provider docs, "Resources", warning box).
      resources: [{ identifier: MCP_RESOURCE, name: 'rssify MCP', allowedScopes: ['openid', 'profile', 'email', 'offline_access', MCP_SCOPE] }],
      clientRegistrationDefaultScopes: ['openid', 'offline_access', MCP_SCOPE],
      // DCR fallback: owner question M2. Recommended: on.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultApplicationType: 'infer',
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    apiKey({ defaultPrefix: 'rss_', rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 } }),
    nextCookies(),
  ],
});
```

- One custom scope, `reader`. Every MCP tool needs it
  (`requiredScopes: ['reader']`). Like API keys, all MCP grants carry the
  same rights in v1; a read-only scope is listed for later. One scope
  rather than none, so that protected resource metadata advertises
  something for clients to request, and the challenge names it.
- `resource` is HTTPS in production. `http://localhost:3210/api/mcp` is
  allowed locally, because `validateMcpResource` accepts HTTP on loopback
  hosts only.
- The ship team confirms the scope wiring for CIMD and DCR clients with
  the end-to-end test in §7.5. If a CIMD client's document carries no
  `scope`, the default may differ from `clientRegistrationDefaultScopes`;
  the test shows it.

**Prisma models it adds.** These come from `@better-auth/oauth-provider`
1.7.12 `dist/authorize-*.mjs` (`const schema`) and `better-auth` 1.7.12
`dist/plugins/jwt/schema.mjs`. `@better-auth/cimd` adds no table; it
stores discovered clients in `oauthClient` with `clientDiscoveryId:
'cimd'`. DPoP replay records go in the existing `verification` table
(`createDpopReplayStore` in `@better-auth/core` `dist/oauth2/dpop.mjs`).

The docs' schema section lists only five tables; the 1.7.12 source has
seven plus `jwks`. As for the rest of the auth models, `bunx
@better-auth/cli generate` output wins over this listing. A better-auth
reference without `onDelete` is `cascade` (`dist/db/get-migration.mjs`),
and the models below say so explicitly.

```prisma
// ---------- better-auth 1.7.12 jwt() ----------

model Jwks {
  id         String    @id
  publicKey  String
  privateKey String // encrypted with BETTER_AUTH_SECRET
  createdAt  DateTime
  expiresAt  DateTime?
  alg        String?
  crv        String?

  @@map("jwks")
}

// ---------- @better-auth/oauth-provider 1.7.12 (via @better-auth/mcp) ----------

model OauthClient {
  id                               String    @id
  clientId                         String    @unique
  clientSecret                     String?
  clientDiscoveryId                String? // 'cimd' for CIMD clients, null for DCR/managed
  disabled                         Boolean?  @default(false)
  skipConsent                      Boolean?
  enableEndSession                 Boolean?
  subjectType                      String?
  scopes                           String[]
  clientCredentialsScopes          String[]  @default([])
  userId                           String?
  user                             User?     @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt                        DateTime?
  updatedAt                        DateTime?
  name                             String?
  uri                              String?
  icon                             String?
  contacts                         String[]
  tos                              String?
  policy                           String?
  softwareId                       String?
  softwareVersion                  String?
  softwareStatement                String?
  redirectUris                     String[]
  postLogoutRedirectUris           String[]
  backchannelLogoutUri             String?
  backchannelLogoutSessionRequired Boolean?
  tokenEndpointAuthMethod          String?
  applicationType                  String?
  jwks                             String?
  jwksUri                          String?
  grantTypes                       String[]
  responseTypes                    String[]
  requirePKCE                      Boolean?
  dpopBoundAccessTokens            Boolean?  @default(false)
  referenceId                      String?
  metadata                         Json?

  resources     OauthClientResource[]
  refreshTokens OauthRefreshToken[]
  accessTokens  OauthAccessToken[]
  consents      OauthConsent[]

  @@index([userId])
  @@map("oauthClient")
}

model OauthResource {
  id                            String    @id
  identifier                    String    @unique // the RFC 8707 resource, = MCP_RESOURCE
  name                          String
  accessTokenTtl                Int?
  refreshTokenTtl               Int?
  signingAlgorithm              String?
  signingKeyId                  String?
  allowedScopes                 String[]
  customClaims                  Json?
  dpopBoundAccessTokensRequired Boolean?  @default(false)
  disabled                      Boolean?  @default(false)
  createdAt                     DateTime?
  updatedAt                     DateTime?
  policyVersion                 Int?      @default(1)
  metadata                      Json?

  clients OauthClientResource[]

  @@map("oauthResource")
}

model OauthClientResource {
  id         String        @id
  clientId   String
  client     OauthClient   @relation(fields: [clientId], references: [clientId], onDelete: Cascade)
  resourceId String
  resource   OauthResource @relation(fields: [resourceId], references: [identifier], onDelete: Cascade)
  metadata   Json?
  createdAt  DateTime?

  @@unique([clientId, resourceId])
  @@index([clientId])
  @@index([resourceId])
  @@map("oauthClientResource")
}

model OauthRefreshToken {
  id                      String      @id
  token                   String      @unique // hashed by default (docs, "Storage")
  clientId                String
  client                  OauthClient @relation(fields: [clientId], references: [clientId], onDelete: Cascade)
  sessionId               String?
  session                 Session?    @relation(fields: [sessionId], references: [id], onDelete: SetNull)
  userId                  String
  user                    User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  referenceId             String?
  authorizationCodeId     String?
  resources               String[]
  requestedUserInfoClaims String[]
  expiresAt               DateTime
  createdAt               DateTime
  revoked                 DateTime?
  rotatedAt               DateTime?
  rotationReplayResponse  String?
  rotationReplayExpiresAt DateTime?
  authTime                DateTime?
  confirmation            Json?
  scopes                  String[]

  accessTokens OauthAccessToken[]

  @@index([clientId])
  @@index([sessionId])
  @@index([userId])
  @@index([authorizationCodeId])
  @@map("oauthRefreshToken")
}

// Opaque access tokens only (issued when a request names no resource).
// MCP tokens are JWTs and are not stored.
model OauthAccessToken {
  id                      String             @id
  token                   String             @unique
  clientId                String
  client                  OauthClient        @relation(fields: [clientId], references: [clientId], onDelete: Cascade)
  sessionId               String?
  session                 Session?           @relation(fields: [sessionId], references: [id], onDelete: SetNull)
  userId                  String?
  user                    User?              @relation(fields: [userId], references: [id], onDelete: Cascade)
  referenceId             String?
  authorizationCodeId     String?
  resources               String[]
  requestedUserInfoClaims String[]
  refreshId               String?
  refresh                 OauthRefreshToken? @relation(fields: [refreshId], references: [id], onDelete: Cascade)
  expiresAt               DateTime
  createdAt               DateTime
  revoked                 DateTime?
  confirmation            Json?
  scopes                  String[]

  @@index([clientId])
  @@index([sessionId])
  @@index([userId])
  @@index([authorizationCodeId])
  @@index([refreshId])
  @@map("oauthAccessToken")
}

model OauthConsent {
  id                      String      @id
  clientId                String
  client                  OauthClient @relation(fields: [clientId], references: [clientId], onDelete: Cascade)
  userId                  String?
  user                    User?       @relation(fields: [userId], references: [id], onDelete: Cascade)
  referenceId             String?
  resources               String[]
  requestedUserInfoClaims String[]
  scopes                  String[]
  createdAt               DateTime
  updatedAt               DateTime

  @@index([clientId])
  @@index([userId])
  @@map("oauthConsent")
}

model OauthClientAssertion {
  id        String   @id // digest of the private_key_jwt jti
  expiresAt DateTime

  @@map("oauthClientAssertion")
}
```

`User` gains `oauthClients OauthClient[]`, `oauthRefreshTokens
OauthRefreshToken[]`, `oauthAccessTokens OauthAccessToken[]` and
`oauthConsents OauthConsent[]`. `Session` gains `oauthRefreshTokens` and
`oauthAccessTokens`. The migration is additive (§3); deleting a user
deletes their consents and tokens by cascade.

**Routes it mounts** (all under the existing
`app/api/auth/[...all]/route.ts`, base path `/api/auth`, so the issuer is
`<BETTER_AUTH_URL>/api/auth`):

- `/oauth2/authorize`, `/oauth2/token`, `/oauth2/register` (only when DCR
  is on), `/oauth2/consent`, `/oauth2/continue`, `/oauth2/userinfo`,
  `/oauth2/revoke`, `/oauth2/introspect`, `/oauth2/end-session`;
- client and consent management (`/oauth2/get-consents`,
  `/oauth2/delete-consent`, `/oauth2/get-client`, `/oauth2/public-client`,
  …, and `/admin/oauth2/*`, which needs server-side calls);
- `/jwks` (from `jwt()`);
- `/.well-known/openid-configuration` and
  `/.well-known/oauth-authorization-server` under the issuer path.

Source: the `createAuthEndpoint` paths in `@better-auth/oauth-provider`
1.7.12 `dist/*.mjs`.

**Next.js route files we add** (the catch-all only sees `/api/auth/*`;
the root well-known URLs must reach better-auth too):

| File | Serves | Body |
| --- | --- | --- |
| `app/.well-known/oauth-protected-resource/[[...path]]/route.ts` | `/.well-known/oauth-protected-resource` and `…/api/mcp` (RFC 9728) | `export const GET = (req: Request) => auth.handler(req);` (`mcp()`'s `onRequest` answers) |
| `app/.well-known/oauth-authorization-server/[[...path]]/route.ts` | `/.well-known/oauth-authorization-server/api/auth` (RFC 8414 path insertion) | `export const GET = oauthProviderAuthServerMetadata(auth);` |
| `app/.well-known/openid-configuration/[[...path]]/route.ts` | `/.well-known/openid-configuration/api/auth`, which some clients try | `export const GET = oauthProviderOpenIdConfigMetadata(auth);` |
| `app/api/mcp/route.ts` | the MCP endpoint (§7.2) | |
| `app/consent/page.tsx` | the consent screen | interface's; contract below |

**Env.** No new variables. The resource is derived from `BETTER_AUTH_URL`.
The signing key lives in `jwks`, encrypted with `BETTER_AUTH_SECRET`, so
that secret must stay stable (it already must, for sessions). No new
service, no paid plan.

**Sign in with Vercel during the MCP flow.**

1. The MCP client opens `/api/auth/oauth2/authorize?…`.
2. With no session, the provider redirects to `/sign-in?<signed query>`.
3. The existing "Sign in with Vercel" button works unchanged once
   `lib/auth-client.ts` adds `oauthProviderClient()`. That client plugin
   copies `window.location.search` into the `oauth_query` body of the
   `POST /sign-in/social` (`@better-auth/oauth-provider` `dist/client.mjs`).
4. The provider's `before` hook verifies the signature and stores the
   query in the OAuth state for `/sign-in/social`.
5. When the Vercel callback sets the session cookie, its `after` hook
   resumes `/oauth2/authorize` (`dist/authorize-*.mjs`, `hooks`). The
   browser goes on to `/consent`, then back to the client's redirect URI
   with a code.

A user who is already signed in goes straight to consent.

**The registration gate holds unchanged.** A new Vercel account while
registration is closed fails in `databaseHooks.user.create.before`, as it
does today. The flow ends on `/sign-in?error=signup_disabled` and the MCP
client never gets a code. The admin is not special in MCP: no tool is an
admin tool, and an MCP grant never carries admin rights, as an API key
doesn't.

**Consent page contract** (for interface):

- The server component reads `searchParams` and returns `notFound()`
  unless `verifyOAuthQueryParams` passes.
- It requires a session; with none, it redirects to `/sign-in` with the
  same query.
- It shows the client's `client_name` and `uri` (from
  `auth.api.getOAuthClientPublic`) and one sentence for the `reader`
  scope.
- Allow and Deny call `authClient.oauth2.consent({ accept: true | false })`
  and follow the returned redirect.
- Consent is never skipped: CIMD and DCR clients are anyone's.

### 7.2 Serving MCP from the App Router on Vercel

**Chosen: the official SDK v2, `@modelcontextprotocol/server` 2.3.1,
directly.** Options:

- **`@modelcontextprotocol/server` 2.3.1.** Its `createMcpHandler(factory,
  options)` returns `{ fetch(request, { authInfo }) }`, a Web-standard
  handler. Per request it serves the 2026-07-28 protocol (stateless, no
  sessions), and by default (`legacy: 'stateless'`) it answers 2025-era
  Streamable HTTP clients statelessly from the same factory (GET and
  DELETE get `405`). Source: `dist/createMcpHandler-*.d.mts`,
  `CreateMcpHandlerOptions`. It is the package better-auth's MCP docs
  wire `requireMcpAuth` to.
- **Vercel's `mcp-handler` 2.3.0.** It is maintained (published
  2026-10-07, Vercel Labs), but 2.x is a wrapper over the same SDK v2
  (peer `@modelcontextprotocol/server ^2.0.0`; README: "Built on MCP SDK
  v2"). Its extras, `withMcpAuth` and `protectedResourceHandler`, are what
  better-auth already gives. One more dependency for nothing we need.
- **`@modelcontextprotocol/sdk` 1.32.1** is the v1 line; the v2 README says
  v2 "replaces the single `@modelcontextprotocol/sdk` package".

**Transport:** Streamable HTTP, one `POST /api/mcp`. No SSE endpoint, no
Redis, no session store. `responseMode` stays `'auto'`: JSON unless a tool
emits a notification first, which ours don't. `subscriptions/listen` is
not offered, so the in-process event bus is never used across instances.

**Legacy era: `legacy: 'stateless'` (the default), not `'reject'`.**
better-auth's example uses `'reject'`. We keep the default so clients
still on the 2025-11-25 protocol work today. It holds no state either way.

**Statelessness on serverless.** The factory builds a fresh `McpServer`
per request, and the actor arrives through `authInfo`. Nothing lives
between requests except Postgres. Any instance can serve any request.

`app/api/mcp/route.ts`:

```ts
import { createMcpHandler, originValidationResponse } from '@modelcontextprotocol/server';
import { requireMcpAuth } from '@better-auth/mcp';
import { auth, MCP_RESOURCE, MCP_SCOPE } from '@/lib/auth';
import { actorFromApiKey, actorFromMcpClaims } from '@/lib/actor';
import { buildMcpServer } from '@/lib/mcp/server';

export const maxDuration = 60; // subscribe may fetch a feed (15 s) or run a plugin (40 s)

const mcp = createMcpHandler(({ authInfo }) => buildMcpServer(authInfo!.extra!.userId as string));
const appHost = new URL(MCP_RESOURCE).hostname;

const viaOAuth = requireMcpAuth(auth, async (req, claims) => {
  const actor = await actorFromMcpClaims(claims); // null → 401 (below)
  if (!actor) return unauthorized();
  return mcp.fetch(req, { authInfo: toAuthInfo(claims, actor) });
}, { resource: MCP_RESOURCE, requiredScopes: [MCP_SCOPE] });

export async function POST(req: Request) {
  const badOrigin = originValidationResponse(req, [appHost]); // a present, foreign Origin → 403
  if (badOrigin) return badOrigin;
  if (req.headers.has('x-api-key')) {
    const r = await actorFromApiKey(req.headers); // same as /api/v1: 401 / 429
    if (!r.ok) return r.response;
    return mcp.fetch(req, { authInfo: { token: 'api-key', clientId: 'api-key', scopes: [MCP_SCOPE], extra: { userId: r.actor.userId } } });
  }
  return viaOAuth(req);
}
```

Only `POST` is exported, so Next.js answers other methods with `405`.

**`actorFromMcpClaims(claims)`** (`lib/actor.ts`) runs one indexed query:
does an `oauthConsent` row exist for (`userId = sub`, `clientId = azp`)
whose user exists? If yes it returns `{ userId: sub, isAdmin: false }`,
otherwise `null`. JWT verification alone has no database check. This
query makes two things take effect at once rather than at token expiry
(up to 1 h): deleting a user, and disconnecting an app (§7.7). Our
clients never have `skipConsent`, so every valid grant has a consent row.

**Origin.** The SDK leaves Origin and Host validation to the caller.
`originValidationResponse` with our own host refuses a browser request
from a foreign page. MCP clients that are not browsers send no `Origin`
and pass. No cookie is ever read on this route, so there is no ambient
authority to protect beyond that.

**Rate limits.** An API key on MCP keeps its 120 requests per minute.
OAuth calls have no per-token limit in v1 (only signed-in users can get a
token; small scale). better-auth's per-IP limits apply to `/oauth2/*`
(`/oauth2/register` 5 per minute, `/oauth2/token` 20 per minute;
oauth-provider docs, "Rate Limiting"). Like the rest of better-auth's
limiter, these are per instance in memory.

### 7.3 API keys on MCP

**Recommended, and drawn so: an `x-api-key` header also authenticates
`/api/mcp`.** It is the same check as `/api/v1`, with the same 401/429
and the same rate limit. A request with the header never enters the
OAuth path.

- It costs one branch, and makes MCP usable from clients that take a
  static header (`claude mcp add --transport http … --header "x-api-key:
  rss_…"`, Cursor and others), from scripts, and in the by-hand checks
  without a browser.
- OAuth stays the default and the path MCP clients discover. The spec
  requires a server to reject OAuth tokens not issued for it ("MUST NOT
  accept or transit any other tokens"). An API key is not an OAuth token
  and travels in its own header. `Authorization: Bearer rss_…` is not
  accepted: there, a key would be read as a broken JWT.
- The alternative of API key only, with no OAuth at all, is much simpler
  (no `jwt`, `mcp` or `cimd` plugin, eight fewer tables, no consent page).
  But clients that can only run the OAuth flow could not connect. That
  choice is the owner's: **M1**.

### 7.4 Tools, actions and API: one implementation, three adapters

All three call `lib/reader.ts` with a `userId`. Inputs are parsed by the
same zod schemas in `lib/reader-schemas.ts`: the server actions parse
their arguments, `/api/v1` parses query and body, and the MCP SDK takes
them as `inputSchema`. Outputs are the `/api/v1` JSON shapes (DESIGN.md
§5.3). An MCP tool returns them as `structuredContent` (with an
`outputSchema`), and also as one JSON `text` block for clients without
structured output.

```ts
// lib/reader-schemas.ts
import * as z from 'zod';
import { builtinSources } from '@/sources/builtin';

export const Id = z.string().min(1).max(64);
export const SubscribeInput = z
  .object({
    url: z.url().max(2048).optional().describe('A feed URL or a website address'),
    source: z.enum(builtinSources.map((s) => s.id) as [string, ...string[]]).optional().describe('A built-in source id'),
  })
  .refine((v) => (v.url ? 1 : 0) + (v.source ? 1 : 0) === 1, 'Give exactly one of url or source');
export const UnsubscribeInput = z.object({ feedId: Id });
export const ListEntriesInput = z.object({
  feedId: Id.optional().describe('Only this feed; all feeds when absent'),
  unreadOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional().describe('nextCursor from the previous page'),
});
export const EntryInput = z.object({ entryId: Id });
export const MarkAllReadInput = z.object({
  feedId: Id.optional(),
  upTo: z.iso.datetime().describe('asOf from list_entries; later entries stay unread'),
});
```

The `lib/reader.ts` signatures, and the types exported from it:

```ts
listSubscriptions(userId): Promise<{ subscriptions: SubscriptionView[] }>
subscribe(userId, input: SubscribeInput): Promise<SubscribeResult> // { ok: true, subscription, existed } | { ok: false, code, choices? }
unsubscribe(userId, feedId): Promise<void>                          // throws NotFound
listEntries(userId, input: ListEntriesInput): Promise<{ entries: EntryListItem[]; nextCursor: string | null; asOf: string }>
getEntry(userId, entryId): Promise<{ entry: EntryView }>          // throws NotFound
markRead(userId, entryId): Promise<void>                            // idempotent; NotFound
markUnread(userId, entryId): Promise<void>
markAllRead(userId, input: MarkAllReadInput): Promise<{ marked: number }>
```

| `lib/reader.ts` | Server action (DESIGN.md §5.2) | `/api/v1` (DESIGN.md §5.3) | MCP tool | Tool input (zod) | Tool output | Annotations |
| --- | --- | --- | --- | --- | --- | --- |
| `listSubscriptions` | (layout loader, not an action) | `GET /subscriptions` | `list_feeds` | `{}` | `{ subscriptions: [{ id, createdAt, unreadCount, feed: { id, url, title, siteUrl, sourceId, status, lastError, lastSuccessAt } }] }` | readOnly |
| `subscribe` | `subscribe({ url } \| { source })` | `POST /subscriptions` | `subscribe` | `SubscribeInput` | `{ subscription, existed }` | openWorld (fetches the URL) |
| `unsubscribe` | `unsubscribe(feedId)` | `DELETE /subscriptions/:feedId` (see lead question 1) | `unsubscribe` | `UnsubscribeInput` | `{ ok: true }` | destructive (the last subscriber's leaving deletes the feed and its entries) |
| `listEntries` | (page loader) | `GET /entries?feedId=&unread=&limit=&cursor=` | `list_entries` | `ListEntriesInput` | `{ entries: [{ id, feedId, feedTitle, title, url, author, summary, publishedAt, sortAt, read }], nextCursor, asOf }` | readOnly |
| `getEntry` | (page loader) | `GET /entries/:id` | `get_entry` | `EntryInput` | `{ entry: { …, contentHtml } }`; does **not** mark read (DESIGN.md §5.4) | readOnly |
| `markRead` | `markRead(entryId)` | `PUT /entries/:id/read` | `mark_read` | `EntryInput` | `{ ok: true }` | idempotent |
| `markUnread` | `markUnread(entryId)` | `DELETE /entries/:id/read` | `mark_unread` | `EntryInput` | `{ ok: true }` | idempotent |
| `markAllRead` | `markAllRead({ feedId?, upTo })` | `POST /entries/read` | `mark_all_read` | `MarkAllReadInput` | `{ marked }` | idempotent |

- **Errors.** `lib/reader.ts` throws `ReaderError { code }`; `NotFound` is
  `not_found`, and subscribe returns the §4 codes. Each adapter maps the
  same codes:
  - a server action returns `{ ok: false, code }`, which becomes a toast
    or a form error;
  - `/api/v1` answers 404 or 422 with `{ error: { code, message } }`;
  - an MCP tool returns `isError: true` with the text `"<code>: <the §4
    sentence>"`, so the model reads the reason. A JSON-RPC error is used
    only for protocol faults, and the SDK raises those itself, such as an
    input that fails zod.
  - Anything not the caller's is `not_found` on all three, never
    "forbidden".
- `lib/mcp/server.ts` exports `buildMcpServer(userId)`. It returns a
  `new McpServer({ name: 'rssify', version })` with the eight
  `registerTool` calls. Each is three lines: parse (SDK), call
  `lib/reader.ts`, wrap. Tool descriptions say what the API docs say,
  including "pass `asOf` from `list_entries` as `upTo`".
- **Size.** `get_entry` can return up to 200 KB of HTML (the ingest cap).
  The tool description tells the model so. A plain-text variant is listed
  for later.
- **No MCP resources or prompts in v1;** tools only.

### 7.5 Tests for MCP (no network, no Vercel)

They run in `bun test` against `rssify_test`, as in §6.

**Seams:**

- Handlers are called as functions: `POST(new Request('http://localhost:3210/api/mcp', { method: 'POST', headers, body }))`, and the well-known `GET`s the same way.
- The self-fetched JWKS (§7.1) is answered in process. `test/jwks.ts`
  wraps `globalThis.fetch` for the run: a request to
  `http://localhost:3210/api/auth/jwks` goes to `auth.handler(request)`,
  and any other URL throws, so a test that tries the network fails loudly.
- Valid tokens are real ones, minted in process by `test/mcp-token.ts`
  through `auth.handler`:
  1. insert a user and a session;
  2. create a public client with `auth.api.adminCreateOAuthClient`
     (`token_endpoint_auth_method: 'none'`, redirect
     `http://127.0.0.1:9/cb`, nothing listens there);
  3. `GET /api/auth/oauth2/authorize` with the session cookie, PKCE S256,
     `resource=MCP_RESOURCE` and `scope=openid offline_access reader`;
  4. `POST /api/auth/oauth2/consent` with `accept: true`;
  5. read the code from `Location`;
  6. `POST /api/auth/oauth2/token` with `code_verifier` and `resource`.

  This also proves the configuration: the Prisma list columns, resource
  binding, scopes.
- Bad tokens are minted with `jose` 6 (already in the tree through
  `@better-auth/mcp`), from a key pair the test generates.

**`app/api/mcp/route.test.ts`, token verification, negative cases:**

- no `Authorization` and no `x-api-key` → `401`; the body is a JSON-RPC
  error; `WWW-Authenticate` carries
  `resource_metadata="http://localhost:3210/.well-known/oauth-protected-resource/api/mcp"`;
- `Authorization: Bearer not-a-jwt` → `401`;
- `Authorization: Basic …` → `401`;
- a JWT signed by a foreign key (right `iss`, `aud`) → `401`;
- a JWT from our key with the wrong `aud` (another resource) → `401`;
- the wrong `iss` → `401`;
- expired → `401`;
- no `azp` → `401`;
- a valid token without `reader` → `403`; `WWW-Authenticate` has
  `error="insufficient_scope"` and `scope="reader"`;
- a valid token after its consent is deleted (app disconnected) → `401`;
- a valid token after the user is deleted → `401`;
- the token in the query string (`?access_token=`) is ignored → `401`;
- `Authorization: Bearer rss_…` (a key in the wrong header) → `401`;
- `x-api-key`: revoked → `401`; expired → `401`; the 121st call in a
  minute → `429` with `Retry-After`;
- a foreign `Origin` → `403`; no `Origin` passes;
- `GET` and `DELETE` → `405`.

**Positive and tool cases** (with a valid token, and once with an API key):

- `tools/list` returns exactly the eight tools, with input schemas;
- the 2025-era `initialize` handshake gets a stateless answer too
  (`legacy: 'stateless'`);
- `list_feeds` returns only the caller's subscriptions, with unread counts;
- `subscribe` to an existing feed makes no fetch and returns
  `existed: true`; with neither or both of `url` and `source` → input
  error;
- `list_entries` pages with `nextCursor` and `unreadOnly`;
- `get_entry` of another user's entry → `isError`, `not_found`;
- `get_entry` does not mark read;
- `mark_read` and `mark_unread` are idempotent;
- `mark_all_read` respects `upTo`;
- `unsubscribe` of the last subscriber deletes the feed.

**Parity, `lib/adapters.test.ts`:** one scenario run through a server
action, `/api/v1` and an MCP tool gives the same data, so the three
adapters cannot drift.

**Well-known, `app/.well-known/*.test.ts`:**

- protected resource metadata, at both paths: `resource =
  http://localhost:3210/api/mcp`, `authorization_servers =
  ['http://localhost:3210/api/auth']`, `scopes_supported = ['reader']`;
- authorization server metadata: `issuer`,
  `code_challenge_methods_supported` contains `S256`,
  `client_id_metadata_document_supported: true`, `registration_endpoint`
  present only when DCR is on;
- OIDC configuration answers.

**`lib/mcp-clients.test.ts`:**

- disconnect deletes the consent and revokes that client's refresh
  tokens; other clients are untouched;
- the cleanup (§7.7) removes expired rows and unused DCR clients only.

**By hand only** (local dev server on 3210, dev Vercel App):

1. `claude mcp add --transport http rssify http://localhost:3210/api/mcp`,
   then `/mcp` in Claude Code to authenticate. The browser goes to
   `/sign-in`, then Vercel, then `/consent` (Allow), then back to Claude
   Code. Ask it to list feeds, read an entry, mark it read, and see the
   UI agree after a reload.
2. The same with a fresh Vercel account while registration is closed: the
   flow ends on "Registration is closed".
3. A CIMD client (one whose `client_id` is an HTTPS URL; this needs the
   dev server to fetch it from the internet). Then a DCR client, if M2
   keeps DCR on.
4. Disconnect the app in Settings; the next tool call gets `401`, and the
   client asks to sign in again.
5. `claude mcp add --transport http rssify-key http://localhost:3210/api/mcp --header "x-api-key: rss_…"`:
   tools work with no browser. Revoke the key, and calls fail.
6. The MCP Inspector (`npx @modelcontextprotocol/inspector`) against the
   same URL, to see the challenge and the metadata documents.

### 7.6 Races and failures

| Case | What happens |
| --- | --- |
| Two MCP calls at once from one client | Independent requests; the same rules as §3a (marks idempotent, subscribe `ON CONFLICT`). |
| Mark read over MCP while the UI marks unread | Last writer wins, per row; both idempotent. The UI shows the state on its next render. |
| The access token expires mid-conversation | `401` with the challenge; the client refreshes and retries. |
| Two refreshes with one refresh token (client retry) | The 30 s reuse window in `mcp()` returns the same new pair; after it, the old token is refused. |
| The user deletes their account, or the admin deletes the user | Cascade deletes consents and refresh tokens. The next MCP call fails the consent check → `401`. |
| An app disconnected in Settings | Consent deleted, refresh tokens revoked, in one transaction. The next call → `401`. |
| The JWKS self-fetch fails (cold instance, deploy in progress) | `verify.mjs` throws a JOSE infrastructure error, which is not a 401. The route answers `500`; the client retries. |
| CIMD document unreachable or invalid | The authorization request fails closed; no client row is written or changed (cimd docs, "Persistence and refresh"). |
| DCR spam | 5 registrations per minute per IP per instance. Unused DCR clients are pruned by the cron cleanup (§7.7). |
| Registration closed, new account in the MCP flow | `signup_disabled`, as in §3a; no code is issued. |
| `BETTER_AUTH_URL` wrong on a deploy | Tokens' `aud`/`iss` don't match the route, so everything is `401`. The by-hand step 1 catches it. |
| `subscribe` over MCP takes longer than the client's timeout | The server finishes within `maxDuration = 60`. A retry finds the feed and returns `existed: true`. |
| An older build without the MCP tables is still serving during rollout | It never touches them; the migration is additive. |

### 7.7 Connected apps and cleanup

- `lib/mcp-clients.ts`:
  - `listConnectedApps(userId)` joins `oauthConsent` and `oauthClient` and
    gives `{ clientId, name, uri, createdAt }`;
  - `disconnectApp(userId, clientId)` deletes the consent and sets
    `revoked = now()` on that user's refresh tokens for the client, in one
    transaction.

  Deleting a consent through better-auth's own `/oauth2/delete-consent`
  does not touch refresh tokens (`dist/authorize-*.mjs`), hence our
  function. The Settings screen lists these beside API keys; that is
  interface's question 7 below.
- **Cleanup** in `lib/auth-cleanup.ts`, called at the end of every run
  of the cron route (ingest's). Four `deleteMany` calls, each on a small
  table:
  - `oauthRefreshToken` with `expiresAt < now()`;
  - `oauthAccessToken` with `expiresAt < now()`;
  - `oauthClientAssertion` with `expiresAt < now()`;
  - `oauthClient` with `clientDiscoveryId` null, `userId` null, created
    more than a day ago, and no consent and no refresh token (DCR clients
    that never finished a flow).

  There is no new cron and no new job. `verification` rows are left to
  better-auth.

### 7.8 Build units

These slot into DESIGN.md §13 after unit 12 (Settings, API keys UI and
`/api/v1`), because MCP reuses `lib/reader.ts` (unit 2), add-feed (unit
6) and `lib/actor.ts`. Admin and CI move to 15 and 16.

13. **OAuth provider for MCP.**
    - `jwt()`, `mcp()`, `cimd()` in `lib/auth.ts`, plus `disabledPaths`;
    - `oauthProviderClient()` in `lib/auth-client.ts`;
    - the schema additions and their migration;
    - the three `app/.well-known/*` routes;
    - `/consent`;
    - `actorFromMcpClaims`;
    - `lib/mcp-clients.ts` and "Connected apps" in Settings;
    - `lib/auth-cleanup.ts` in the cron route;
    - tests: well-known, the token minting helpers, disconnect, cleanup.
14. **MCP server.**
    - `lib/reader-schemas.ts`; the actions and `/api/v1` switch to it, a
      refactor with no change in behaviour;
    - `lib/mcp/server.ts` with the eight tools;
    - `app/api/mcp/route.ts`, with OAuth and `x-api-key`;
    - tests: the route's negative cases, the tools, parity.

    Dependencies: `@better-auth/mcp`, `@better-auth/cimd`,
    `@modelcontextprotocol/server`, `zod`.

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
6. **OAuth provider for MCP** (§7.8, unit 13 there).
7. **MCP server** and its eight tools (§7.8, unit 14 there).
8. **Admin page.**
9. **CI workflow.**

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
- MCP authorization through `@better-auth/mcp` 1.7.12 (`mcp()`, built on
  `@better-auth/oauth-provider`), with `jwt()` and `cimd()`; the legacy
  `better-auth/plugins` `mcp` is not used (it is gone in 1.7). Login page
  `/sign-in` (Sign in with Vercel, unchanged), consent page `/consent`,
  one scope `reader`. No new env variable.
- The MCP server is `@modelcontextprotocol/server` 2.3.1 `createMcpHandler`
  at `POST /api/mcp`: stateless, Streamable HTTP, `legacy: 'stateless'`
  so 2025-era clients work, `maxDuration = 60`. Not Vercel's `mcp-handler`
  (a wrapper over the same SDK).
- `x-api-key` also authenticates `/api/mcp`, with the same checks as
  `/api/v1`.
- Eight MCP tools, one per `lib/reader.ts` function. Shared zod schemas in
  `lib/reader-schemas.ts`. Outputs are the `/api/v1` shapes.
- Each MCP call checks that the consent and the user still exist, so
  disconnecting an app or deleting a user takes effect at once.
- Expired OAuth rows and unused DCR clients are pruned at the end of the
  cron route; there is no new job.

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
5. **M1. How MCP clients authenticate.**
   - (a) OAuth (better-auth `mcp()` + CIMD) and also `x-api-key`:
     **recommended**. Any MCP client can connect: those that only run the
     OAuth flow, and those configured with a static header.
   - (b) `x-api-key` only. This is far simpler: no `jwt`/`mcp`/`cimd`
     plugins, eight fewer tables, no `/consent`, no well-known routes,
     no connected-apps list. Clients that can only do OAuth (a URL and
     nothing else) cannot connect.
   - (c) OAuth only.
6. **M2. Dynamic Client Registration as a fallback to CIMD.** The
   2026-07-28 spec deprecates DCR and better-auth leaves it off by
   default, but its docs name Cursor and older Claude Code releases as
   clients that still register by DCR.
   - (a) CIMD + DCR: **recommended**, for compatibility. Anyone can create
     a client row, at 5 per minute per IP; unused ones are pruned.
   - (b) CIMD only: fewer moving parts, but some clients cannot connect
     until they adopt CIMD.

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
6. A `/consent` page for the MCP OAuth flow, to the contract in §7.1:
   client name and site, one sentence for `reader`, Allow and Deny, its
   error and expired-link states. `/sign-in` keeps its query string and
   uses `oauthProviderClient()`; the button itself is unchanged.
7. "Connected apps" in Settings, beside API keys: name, site, connected
   on, [Disconnect] with a confirm (`lib/mcp-clients.ts`). The API keys
   hint gains the MCP form: `claude mcp add --transport http rssify
   <origin>/api/mcp --header "x-api-key: …"`.

## Questions for the lead

1. **Unsubscribe ids do not line up.** DESIGN.md §5.2 has
   `unsubscribe(feedId)`, and §5.3 has `DELETE /api/v1/subscriptions/:id`
   with a subscription id. Proposal: `:feedId` in the API path, as the
   action and the MCP tool use. `(userId, feedId)` is unique, and every
   other call (entries filter, mark all) already speaks in `feedId`.
2. DESIGN.md §5.4 refers to "the MCP tools in §5.6", which does not exist
   yet; §7.4 here is its content. §9 gains the plugins and the well-known
   routes of §7.1, §8 the models, §12 the tests of §7.5, §13 units 13–14.
