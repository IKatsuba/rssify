# rssify

rssify is a simple serverless RSS reader with a web UI, a JSON API at `/api/v1`, and an MCP server at `/api/mcp`. All three use the same subscriptions, entries, and read state.

## Features

- Subscribe by feed URL or website address, or choose a built-in source.
- Read all entries or only unread ones; mark entries read, unread, or all read.
- Use keyboard navigation and light, dark, or system theme.
- Manage API keys and connected MCP apps in Settings.
- Refresh feeds automatically through Vercel Cron and Queues.

## Stack

Next.js App Router and React, shadcn/ui with Base UI and Tailwind CSS, Prisma 7 on Neon Postgres, better-auth for Sign in with Vercel, API keys and MCP OAuth, and Vercel Cron and Queues. Bun is the package manager and test runner.

## Self-host on Vercel

Use your own domain wherever `https://your-domain.example` appears below. Users need a Vercel account to sign in.

1. Fork this repository and import the fork as a Vercel project using the Next.js preset. Choose the production domain you will use for authentication.
2. Add Neon Postgres through the Vercel Marketplace and connect it to the project. Check that `DATABASE_URL` contains the pooled connection URL and `DATABASE_URL_UNPOOLED` contains the direct connection URL used for migrations.
3. Create a [Sign in with Vercel app](https://vercel.com/docs/sign-in-with-vercel), register `https://your-domain.example/api/auth/callback/vercel` as its callback URL, and enable the `openid`, `email`, and `profile` scopes. Generate a client secret.
4. Add the environment variables below to the project's Production environment. Keep credentials in Vercel's environment settings.
5. Use the Vercel Pro plan for the checked-in `*/15 * * * *` cron schedule at `/api/cron/refresh`. [Hobby allows daily cron jobs only](https://vercel.com/docs/cron-jobs/usage-and-pricing); this schedule will fail deployment on Hobby.
6. Deploy after the database and environment are configured. Vercel runs `vercel-build`, which generates Prisma's client, applies committed migrations, then builds Next.js. The queue trigger for the `feed-refresh` topic is defined in `vercel.json`. Open the production URL and sign in with the Vercel account whose verified email matches `ADMIN_EMAIL`.

| Variable | Value to configure |
| --- | --- |
| `DATABASE_URL` | Neon pooled Postgres connection URL. |
| `DATABASE_URL_UNPOOLED` | Neon direct connection URL for migrations. |
| `VERCEL_CLIENT_ID` | Sign in with Vercel app's client ID. |
| `VERCEL_CLIENT_SECRET` | Sign in with Vercel app's client secret. |
| `BETTER_AUTH_URL` | Production origin, for example `https://your-domain.example`. |
| `BETTER_AUTH_SECRET` | A strong random secret; keep it stable because it encrypts the JWKS signing key. |
| `ADMIN_EMAIL` | Your Vercel account's verified email address. |
| `REGISTRATION_ENABLED` | `false` to allow only the admin to register; exactly `true` opens registration. |
| `CRON_SECRET` | A strong random secret used to authenticate Vercel's cron requests. |

See [.env.example](.env.example) for all names and local defaults. Do not put production credentials in the repository. If you enable preview deployments, use a separate preview database: `vercel-build` applies migrations on previews too.

## Local development

Install Bun and Docker, clone your fork, then run:

```bash
bun install
bunx prisma generate
cp .env.example .env.local
docker compose up -d
bun --env-file=.env.local run prisma migrate dev
```

Set a local `BETTER_AUTH_SECRET` in `.env.local`; keep `BETTER_AUTH_URL=http://localhost:3210`. For Vercel sign-in, configure your app credentials and register `http://localhost:3210/api/auth/callback/vercel` too. To work locally without Vercel sign-in, these helpers create a local user, mock feeds, and a session:

```bash
bun --env-file=.env.local scripts/dev-seed.ts
bun --env-file=.env.local scripts/dev-session.ts
bun run dev
```

The session helper prints a cookie; set it for `localhost` in your browser's developer tools, then open `http://localhost:3210`. Both helpers refuse a non-local database. Local Postgres runs on `127.0.0.1:54329`; it includes the separate `rssify_test` database used by tests. For a manual local refresh cycle, run `bun --env-file=.env.local scripts/refresh.ts`.

Generate route types on a fresh clone, then run the whole check with Postgres running:

```bash
bunx next typegen
bun run lint && bun run typecheck && bun run test
```

Run one test file with `bun run test ./lib/auth.test.ts`. Tests use local fixtures and `rssify_test`, without live network services. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for contribution and agent guidance.

## Connect an MCP client

Add `https://your-domain.example/api/mcp` as a remote MCP server in your client. Use a client that supports OAuth with Client ID Metadata Documents (CIMD); dynamic client registration is disabled. Request `reader offline_access`, sign in with Vercel, and approve access. The `reader` scope grants reader operations; `offline_access` requests a refresh token so the client can stay connected.

Clients that support custom headers can instead send an API key as `x-api-key`. Tools are `list_feeds`, `subscribe`, `unsubscribe`, `list_entries`, `get_entry`, `mark_read`, `mark_unread`, and `mark_all_read`. Getting an entry does not mark it read. Revoke connected apps or keys from Settings.

## Use the API

Create an API key in Settings and save it when shown; it is shown only once. Send it in the `x-api-key` header. For example, with your key in the local shell variable `RSSIFY_API_KEY`:

```bash
curl 'https://your-domain.example/api/v1/subscriptions' \
  -H "x-api-key: $RSSIFY_API_KEY"

curl 'https://your-domain.example/api/v1/entries?unread=true&limit=20' \
  -H "x-api-key: $RSSIFY_API_KEY"
```

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/subscriptions` | List followed feeds. |
| `POST` | `/api/v1/subscriptions` | Subscribe with JSON `{"url":"https://example.com/feed.xml"}` or `{"source":"source-id"}`. |
| `DELETE` | `/api/v1/subscriptions/{feedId}` | Unsubscribe. |
| `GET` | `/api/v1/entries` | List entries; optional `feedId`, `unread`, `limit` (1–100), and `cursor`. |
| `GET` | `/api/v1/entries/{id}` | Get an entry without marking it read. |
| `PUT` | `/api/v1/entries/{id}/read` | Mark an entry read. |
| `DELETE` | `/api/v1/entries/{id}/read` | Mark an entry unread. |
| `POST` | `/api/v1/entries/read` | Mark all read with JSON `{"upTo":"<asOf>"}` and optional `feedId`. |

Entry lists return `entries`, `nextCursor`, and `asOf`. Pass `nextCursor` as `cursor` for the next page, and the list's `asOf` as `upTo` when marking all read. API keys are limited to 120 requests per minute and grant access only to their owner's reader data.

## License

[MIT](LICENSE), copyright 2026 Igor Katsuba.
