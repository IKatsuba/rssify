# RSSF-1 design: rssify v1, a simple serverless RSS reader

The merged design for rssify v1. It replaces the Deno/Hono Atom service with
a multi-user RSS reader on Next.js (App Router) + shadcn/ui, Neon Postgres
through Prisma, better-auth (Sign in with Vercel, API keys), and Vercel Cron
+ Vercel Queues, on Vercel Pro. It is used three ways, all first-class:
the web UI, an HTTP API (`/api/v1`, API key) and an MCP server
(`/api/mcp`, OAuth through better-auth or an API key), over one set of
functions in `lib/reader.ts`. The owner's rule governs every choice: as
simple as possible, nothing clever.

The record behind it stays in `drafts/`: `brief.md` (the task and the
owner's settled answers), `ingest.md` (measurements, library comparisons,
fixtures), `state.md` (schema sources, races), `interface.md` (screens,
keys, sentences). Where this file and a draft disagree, this file wins.
Versions and doc citations are in the drafts and were checked on 2026-10-21.

Contents: 1 What a person sees · 2 Screens and states · 3 Keys ·
4 Sentences · 5 Routes, server actions, API · 6 Cron, queue, ingest ·
7 Source plugins · 8 Prisma schema · 9 Auth and API keys · 10 Local stack,
config, deploy · 11 Failure cases · 12 Test plan · 13 Build units ·
14 Decisions and options · 15 Critic findings · 16 Owner's answers.

---

## 1. What a person sees and does

- Signs in with Vercel. A new account gets in only while
  `REGISTRATION_ENABLED=true`; the admin (`ADMIN_EMAIL`) always gets in.
- Adds a feed by pasting a feed URL or a site URL (its feed is discovered),
  or picks a built-in source (Claude Code blog, Cursor blog). The add
  happens at once: the feed is fetched while the dialog waits, and the
  person lands on its entries.
- Reads: a sidebar of subscriptions with unread counts; a list of entries
  (all feeds, or one), unread by default, newest first; one entry at a
  time. Opening an entry marks it read. Mark unread, mark all read.
  Keyboard keys for all of it.
- Sees a feed that is failing, or that the site has removed (410).
- Unsubscribes.
- Creates and revokes API keys so readers and scripts can use `/api/v1`
  and `/api/mcp`.
- Connects an MCP client (Claude Code, Cursor, …) to `/api/mcp`: signs in
  with Vercel in the browser, allows it on a consent screen, and later
  disconnects it in Settings. The client then lists feeds, subscribes,
  reads entries and marks them read, as the UI does.
- The admin also sees `/admin`: users and feeds, and can delete a user.

Not in v1: folders/tags, search, stars, sharing, OPML, push, full-text
extraction of RSS entries, per-feed intervals, image proxy, public Atom
output (dropped, owner answer O2), read-only API keys.

## 2. Screens and their states

The preset (`b1D0dxmC`) uses `base-mira` style on Base UI, neutral
monochrome, lucide and Geist. It composes with the `render` prop, not
`asChild`. Layouts cover desktop (1280×800), wide desktop (1680×1000),
phone (390×844), and light and dark themes.

Layout everywhere: shadcn `Sidebar` + `SidebarInset`; the main column shows
the list **or** the entry, never both, at every width. Below 768 px the
sidebar is a `Sheet` (the template's own breakpoint).

### 2.1 Sign-in (`/sign-in`)

One `Card`: "rssify", one line, one full-width "Sign in with Vercel"
`Button` (Vercel logomark SVG inline, `currentColor`). No sign-up form, no
email field.

| State | When |
| --- | --- |
| default | first visit, after sign-out |
| redirecting | button pressed; disabled with `Spinner` |
| registration closed | `?error=signup_disabled` |
| sign-in error | any other `?error=` (e.g. `access_denied`) |

### 2.2 The reader (`/`, `/feeds/[feedId]`)

Sidebar: "rssify"; "All feeds" with the total unread; group "Feeds" with a
`+` ("Add feed") and one item per subscription sorted by title, unread
count in `SidebarMenuBadge` (none at 0). A failing feed shows
`TriangleAlert` instead of `Rss`, muted title; a gone feed shows `CircleOff`.
Foot: the email, opening a `DropdownMenu` (Settings, Keyboard shortcuts,
Admin — admin only, Theme, Sign out).

List header: `SidebarTrigger`, title, **Unread**/**All** (links to
`?filter=`), "Mark all as read". On a feed page a `…` menu: Open website
(hidden when `siteUrl` is null), Copy feed URL, Mark all as read,
Unsubscribe….

Rows: an `Item` link with "Feed · 2h", the title (muted when read), a
two-line summary. 50 per page; **Older entries** / **Newer entries** links
with `?cursor=`. No infinite scroll.

| State | Display |
| --- | --- |
| entries, unread | Unread entries across feeds or in the selected feed |
| entries, All (read rows muted) | All entries, read rows muted |
| one feed, menu open | Open website, Copy feed URL, Mark all as read, Unsubscribe… |
| no feeds yet | Empty state with Add feed (§4) |
| loading (`loading.tsx`) | `Skeleton` rows |
| all caught up | Empty state with Show all entries (§4) |
| feed has no entries | Empty state (§4) |
| failing feed (`Alert`, default variant, no red) | Last success and last error (§4) |
| gone feed | Same layout as failing, its own sentence (§4) |
| page error (`error.tsx`) | Error with Try again (§4) |
| unknown / unsubscribed feed (`not-found.tsx`) | `Empty` layout |
| mark all read confirm | `AlertDialog` (§4) |
| unsubscribe confirm | `AlertDialog` (§4) |

### 2.3 An entry (`/entries/[entryId]?feed=&filter=`)

Header: `SidebarTrigger`; **← {list name}** (`u`); ↑/↓ (`k`/`j`, next and
previous *in the list it came from*); **Mark as read/unread** (`m`);
**Open original** (`v`, `target="_blank" rel="noopener noreferrer"`;
disabled when the entry has no valid `url`). Below 640 px icon-only with
`sr-only` labels. Body: `<article>`, meta line, `h1`, content in a `prose`
container (`@tailwindcss/typography`, owner answer O5) at most 65ch.

| State | Display |
| --- | --- |
| content | Article body |
| summary only / nothing | The summary or "This entry has no text", then [Read on {site}] when `url` exists |
| pruned or unknown | Not-found state (§4) |
| loading | `Skeleton` |

Opening marks read through a server action called from the client after
mount, never during the server render; entry links use `prefetch={false}`.
If the person toggles with `m` before that call returns, the client chains
the calls (one promise queue per entry) so the last intent wins.

### 2.4 Add a feed (dialog, from `+`, the empty state, or `a`)

`Dialog` **Add a feed**: a `Field` "URL" + **Add**; a `FieldSeparator` "or
pick a built-in source"; one `Item` per built-in source with [Subscribe]
or a "Subscribed" `Badge`.

| State | Display |
| --- | --- |
| default | URL field and built-in sources |
| adding | Input and button disabled, "Adding…" |
| several feeds found | Pick one feed |
| error under the field | `FieldError` |
| added / already subscribed | Dialog closes, goes to `/feeds/[feedId]`, toast |

The Claude Code item reads "claude.dev — the Claude Code blog's own feed"
(owner answer O1). The Cursor item reads "cursor.com/blog — no feed of its
own".

### 2.5 Settings (`/settings`)

Three `Card`s: **Account** (email, Sign out); **API keys** (`Table`: Name,
Key `start…` monospace, Created, Last used; [Revoke]; [+ Create API key]);
**Keyboard shortcuts** (Show, Turn off/on).

| State | Display |
| --- | --- |
| keys listed | API keys table |
| no keys | Empty state with Create API key (§4) |
| create | Name field, 1–64 characters |
| created, shown once | Copy key dialog (§4) |
| revoke confirm | `AlertDialog` (§4) |
| shortcuts dialog | Keys and their actions (§3) |

Keys have no expiry in v1, so there is no expiry column. A fourth card,
**Connected apps**, lists MCP clients with [Disconnect] (§5.5; the
same `Card` + `Table` + `AlertDialog` as API keys). The
consent screen `/consent` is one `Card` like sign-in (§5.5).

### 2.6 Admin (`/admin`, admin only, 404 for others, no link for others)

**Users** `Table` (Email, "you" badge, Joined, Feeds, [Delete]; not on own
row) with the line about `REGISTRATION_ENABLED`; **Feeds** `Table` (URL,
Subscribers, Status, Failures, Last error, Last success; failing first).
No paging.

### 2.7 shadcn/ui components, as they come

`sidebar` (with `sheet`), `button`, `badge`, `item`, `empty`, `alert`,
`alert-dialog`, `dialog`, `dropdown-menu`, `field`, `input`, `input-group`,
`label`, `kbd`, `skeleton`, `spinner`, `separator`, `table`, `card`,
`tooltip`, `sonner`. Our own additions are layout classes only, `min-w-0`
on `SidebarInset` (long `<pre>` breaks phones otherwise), and one
`prefers-reduced-motion` block in `app/globals.css`. Relative time with
`Intl.RelativeTimeFormat`; no date library. Buttons stay at the preset's
28 px (above WCAG 2.2's 24 px minimum).

## 3. Keys

One client listener for the `(reader)` group (~40 lines, no library). One
guard, `canHandleKey(event)`, exported from it and also used by the
template's `d` listener in `components/theme-provider.tsx` (a one-line
edit). The guard passes only when: shortcuts are on
(`localStorage["rssify:shortcuts"] !== "off"`); the target is not an
`input`, `textarea`, `select` or contenteditable; no dialog, sheet or menu
is open; no modifier but Shift is held. The listener calls
`preventDefault()` only on a key it handles.

| Key | List | Entry |
| --- | --- | --- |
| `j` / `k` | cursor down / up | next / previous entry |
| `o`, `Enter` (focus on body or a row) | open the cursor's entry | — |
| `u`, `Esc` | — | back to the list |
| `m` | toggle read on the cursor row | toggle read |
| `v` | open the original (if any) | open the original (if any) |
| `Shift+A` | mark all read (confirm; `Enter` confirms) | same, for its list |
| `r` | `router.refresh()` | — |
| `a` | Add a feed | Add a feed |
| `?` | shortcuts dialog | same |
| `d` | theme (template) | same |
| `⌘B` / `Ctrl+B` | sidebar (template) | same |

`Space` and `/` are left to the browser. The cursor lives in the client,
starts on the first row, and returns to the entry's row on Back. Under
Unread, `m` removes the row at the next render and the cursor stays at the
same index. The switch (Settings, and the shortcuts dialog) satisfies WCAG
2.1.4 for the single-character keys; `⌘B` is a modified chord and is
outside 2.1.4, so it is left as the template ships it.

Shown in: the `?` dialog (`Kbd`/`KbdGroup` table), tooltips ("Next `J`"),
and `DropdownMenuShortcut` in menus. `⌘` on macOS, "Ctrl" elsewhere.

## 4. The sentences

Style: sentence case, curly apostrophes, no exclamation marks, "you".
Buttons are verbs; a confirming button repeats the title's verb.

**Sign-in.** Line: "A simple RSS reader." Button: "Sign in with Vercel";
redirecting: "Redirecting to Vercel…". Closed: **Registration is closed** ·
"This rssify doesn’t take new accounts right now. If you already have one,
sign in with the same Vercel account." Error: **Sign-in didn’t finish** ·
"Something went wrong with Vercel. Try again."

**Reader states.**

- No feeds: **No feeds yet** · "Add a feed by its URL, or start with one of
  the built-in sources." · [Add feed]
- Caught up: **All caught up** · "Nothing unread. New entries show up here
  as your feeds update." · [Show all entries]
- Feed, nothing under the filter: **No unread entries** · "Older entries
  from this feed are still under All."
- Feed with no entries at all: **No entries yet** · "This feed hasn’t
  published anything we could read. New entries show up here when it
  does."
- Failing: **This feed isn’t updating** · "Last updated {relative
  lastSuccessAt}. The last try failed: {lastError}. We’ll keep trying."
- Gone: **This feed has stopped** · "The site says this feed is gone, so we
  no longer check it. Its entries stay until you unsubscribe."
- Page error: **Couldn’t load your feeds** · "Something went wrong on our
  side. Try again in a moment." · [Try again]
- Feed not found: **Feed not found** · "You aren’t subscribed to this
  feed." · [Back to All feeds]
- Entry gone: **This entry is no longer kept** · "We keep the newest 500
  entries of each feed, and this one is older." · [← Back to All feeds]
- Sidebar tooltip: "Not updating — open for details" / "Stopped — open for
  details".

**Confirmations.** Mark all: **Mark {n} entries as read?** · "Everything
unread in {All feeds | title} up to now. Entries that arrive later stay
unread." · [Cancel] [Mark as read]; toast "Marked {n} entries as read".
Unsubscribe: **Unsubscribe from {title}?** · "It leaves your sidebar, and
its entries leave your lists. You can add it again later." · [Cancel]
[Unsubscribe]; toast "Unsubscribed from {title}".

**Add a feed.** "Paste a feed URL or a website’s address. We’ll find its
feed." Placeholder `https://example.com`. Errors, one per code (§5.3):

| Code | Sentence |
| --- | --- |
| `invalid_url` | "That doesn’t look like a web address." |
| `blocked` | "That address can’t be fetched from here." |
| `unreachable` | "We couldn’t reach {host}. Check the address and try again." |
| `not_found` | "We couldn’t find a feed at that address. Try the site’s feed URL directly." |
| `too_large` | "That feed is too large to read (over 10 MB)." |
| `limit` | "You follow 500 feeds, the most rssify allows. Unsubscribe from one first." |
| `multiple` | "{host} has more than one feed. Pick one." (pick list) |
| anything else | "We couldn’t add that feed. Try again." |

Toasts: "Subscribed to {title}.", "You already follow {title}.".

**Settings and keys.** API keys card: "A key lets a feed reader or a script
read your entries and mark them read. Treat it like a password." No keys:
**No API keys** · "Create one when a reader app or a script needs to reach
your feeds." Create: **Create API key** · "Name it after where you’ll use
it, so you know which one to revoke later." Created: **Copy your new key**
· "This is the only time you’ll see it. If you lose it, revoke it and make
another." · hint "Send it as the x-api-key header." · toast "Key copied".
Revoke: **Revoke “{name}”?** · "Anything using this key stops working at
once. This can’t be undone." · [Revoke key]; toast "Key revoked". Last
used "Never" when null. Shortcuts card: "Single-letter keys like J and K.
Turn them off if they get in your way."

**Admin.** "Registration is {open|closed}. Change REGISTRATION_ENABLED and
redeploy to change it." Delete: **Delete {email}?** · "Their subscriptions,
read marks and API keys are deleted. Feeds others follow stay. This can’t
be undone." · [Delete user].

**Failed actions.** "Couldn’t mark it as read. Try again.", "Couldn’t
unsubscribe. Try again.", "Couldn’t mark entries as read. Try again.",
"Couldn’t create the key. Try again." Session expired: redirect to
`/sign-in`, no toast.

**Titles.** "{n} unread · rssify" (or "rssify"), "{entry} · rssify",
"Settings · rssify", "Sign in · rssify", "Admin · rssify".

**`lastError` texts** (written by ingest, shown as is): "the site answered
{status} {reason}", "the site didn’t answer in time", "the address
couldn’t be found", "the response wasn’t a feed", "the feed is over 10 MB",
"the page layout changed" (plugin found 0 posts), "the address isn’t
allowed".

## 5. Routes, server actions and the API

### 5.1 Pages (App Router)

| Route | Who | Component |
| --- | --- | --- |
| `/sign-in` | signed out (signed in → `/`) | server page reads `?error`; client `SignInButton` |
| `app/(reader)/layout.tsx` | user | `requireUser()` → redirect `/sign-in`; subscriptions + counts → client `AppSidebar`; `export const maxDuration = 60` (add-feed actions run here) |
| `/` and `/feeds/[feedId]` | user | server list (scope, `?filter`, `?cursor`, `asOf`) → client `EntryList` |
| `/entries/[entryId]` | user | server entry + neighbour ids → client `EntryActions` |
| `/settings` | user | `auth.api.listApiKeys` |
| `/admin` | admin | `requireAdmin()` → `notFound()` otherwise |
| `loading.tsx`, `error.tsx` (client), `not-found.tsx` | | per group |

Sidebar and list are separate `Suspense` boundaries. Pages are dynamic
(session cookie); no `use cache`.

### 5.2 Server actions (`app/(reader)/actions.ts`)

Each starts with `requireUser()` (session only), calls `lib/reader.ts`
with the session's `userId` (every function derives ownership from it), and
ends with `revalidatePath('/', 'layout')`.

- `subscribe({ url } | { source })` →
  `{ ok: true, feedId, existed } | { ok: false, code, choices? }` (§6.6)
- `unsubscribe(feedId)`
- `markRead(entryId)`, `markUnread(entryId)`
- `markAllRead({ feedId?, upTo })`
- `createApiKey(name)` → `{ key }`; `revokeApiKey(keyId)` (better-auth,
  session headers)
- `deleteUser(userId)`: `requireAdmin()` again inside; refuses own id.

### 5.3 `/api/v1` (Route Handlers over the same `lib/reader.ts`)

**API key only** (`x-api-key`); cookies are not accepted here, so there is
no CSRF surface on these handlers. JSON; errors
`{ "error": { "code", "message" } }`. Each handler sets
`export const maxDuration = 60`.

- `GET /api/v1/subscriptions` → `{ subscriptions: [{ id, createdAt,
  unreadCount, feed: { id, url, title, siteUrl, pluginId, status,
  lastError, lastSuccessAt } }] }`
- `POST /api/v1/subscriptions` `{ url }` or `{ source }` → `201
  { subscription }` (new), `200` (existing), `422 { error: { code,
  choices? } }` with the §4 codes.
- `DELETE /api/v1/subscriptions/:feedId` → `204` (by feed id, as the action and the MCP tool)
- `GET /api/v1/entries?feedId=&unread=true&limit=50&cursor=` → `{ entries:
  [{ id, feedId, feedTitle, title, url, author, summary, publishedAt,
  sortAt, read }], nextCursor, asOf }`; `limit` ≤ 100.
- `GET /api/v1/entries/:id` → `{ entry: { …, contentHtml } }`
- `PUT|DELETE /api/v1/entries/:id/read` → `204` (idempotent)
- `POST /api/v1/entries/read` `{ feedId?, upTo }` → `{ marked }`

Anything not the caller's gives `404`, never `403`. Status codes: 400, 401,
404, 409, 422, 429.

### 5.4 Read state, end to end (owner requirement)

- **Schema**: `ReadMark(userId, entryId)`, one row per entry a user has
  read; no row = unread (§8). Per user, so one shared entry is read for one
  person and unread for another. It goes with the entry (retention,
  unsubscribe of the last subscriber) and with the user, by cascade.
- **How an entry becomes read**: when the person opens it (the entry page
  calls `markRead` after mount), or by hand: `m` / "Mark as read/unread" on
  a row or an entry, and "Mark all as read" (`Shift+A`, with a confirm,
  bounded by `upTo = asOf`). Options were on open, on scroll past, and by
  hand only. **On open + by hand** is chosen: it is what opening means in a
  one-column reader, needs no scroll observer or timing rules, and never
  marks something read the person only glimpsed. Prefetch cannot mark
  read (marking is never in the render; entry links do not prefetch).
- **Unread counts**: one grouped query per page load (sidebar per feed and
  All feeds, the page title, the mark-all confirm); `revalidatePath` after
  each mark refreshes them. The default list filter is Unread.
- **API and MCP with an API key**: `GET /api/v1/entries?unread=true`
  (each entry carries `read`), `GET /api/v1/subscriptions` (each carries
  `unreadCount`), `PUT|DELETE /api/v1/entries/:id/read`,
  `POST /api/v1/entries/read`; the MCP tools in §5.5 are the same calls.
  Reading an entry through the API (`GET /api/v1/entries/:id`) does **not**
  mark it read: a client says so explicitly, as the UI's open does, so a
  script that only fetches never changes state.
- One implementation: `lib/reader.ts` `markRead`, `markUnread`,
  `markAllRead`, `listEntries({ unreadOnly })`, `listSubscriptions()`
  (with counts); the server actions, `/api/v1` and MCP are thin adapters.

### 5.5 MCP server (owner requirement: first-class in v1)

The record is `drafts/state.md` §7 (versions, sources, the provider's
behaviour); this section is what is built, with the second critic round
applied (§15).

**Serving.** The official MCP TypeScript SDK v2,
`@modelcontextprotocol/server` 2.3.1, `createMcpHandler`, in
`app/api/mcp/route.ts`: one `POST /api/mcp`, Streamable HTTP, stateless
(a fresh `McpServer` per request; nothing between requests but Postgres),
`legacy: 'stateless'` so 2025-era clients work too, `maxDuration = 60`
(subscribe may fetch). No SSE endpoint, no Redis, no session store, no
notifications. Options: Vercel's `mcp-handler` 2.3.0 is maintained but
2.x is a wrapper over the same SDK v2, and its auth extras are what
better-auth already gives; the v1 `@modelcontextprotocol/sdk` is replaced
by the v2 packages. Only `POST` is exported (Next.js also answers
`OPTIONS` itself; other methods `405`). A present, foreign `Origin` is
refused with the SDK's `originValidationResponse`; no cookie is read on
this route.

**Authentication** (§9 has the config):

- **OAuth** (fixed by the owner): better-auth's current MCP support,
  `@better-auth/mcp` `mcp()` (built on `@better-auth/oauth-provider`; the
  legacy `better-auth/plugins` `mcp` is gone in 1.7), with `jwt()` and
  `cimd()`. `requireMcpAuth` verifies the JWT access token (JWKS, `iss`,
  `aud = <BETTER_AUTH_URL>/api/mcp`, `exp`, `azp`, scope `reader`) and
  answers `401` with `WWW-Authenticate: … resource_metadata=…` or `403
  insufficient_scope`. Then one query by primary key checks the user still
  exists (a deleted user's token is refused at once).
- **API key, also** (decided): `x-api-key` on `/api/mcp` is the same check
  as `/api/v1` (401/429, 120/min). It costs one branch and makes MCP usable
  from clients that take a static header and from scripts, with no
  browser. `Authorization: Bearer rss_…` is not accepted.
- **Revocation**: disconnecting an app (Settings) deletes its consent and
  revokes its refresh tokens; an access token already issued stays valid
  until it expires (1 h, the provider's default). Accepted and said in the
  UI; no per-request consent check.

**Tools: one implementation, three adapters.** Every operation is a
`lib/reader.ts` function taking `userId`; inputs are the same zod schemas
(`lib/reader-schemas.ts`) for actions, `/api/v1` and MCP; outputs are the
`/api/v1` JSON shapes (MCP: `structuredContent` with an `outputSchema`,
plus one JSON `text` block). `lib/mcp/server.ts` `buildMcpServer(userId)`
registers the eight tools, each three lines (parse, call, wrap).

| `lib/reader.ts` | Server action | `/api/v1` | MCP tool | Input | Notes |
| --- | --- | --- | --- | --- | --- |
| `listSubscriptions` | (layout loader) | `GET /subscriptions` | `list_feeds` | `{}` | read-only; unread counts |
| `subscribe` | `subscribe` | `POST /subscriptions` | `subscribe` | `{ url } \| { source }` (exactly one) | fetches the URL (open world) |
| `unsubscribe` | `unsubscribe(feedId)` | `DELETE /subscriptions/:feedId` | `unsubscribe` | `{ feedId }` | destructive for the last subscriber |
| `listEntries` | (page loader) | `GET /entries` | `list_entries` | `{ feedId?, unreadOnly = false, limit ≤ 100 = 50, cursor? }` | read-only; returns `asOf` |
| `getEntry` | (page loader) | `GET /entries/:id` | `get_entry` | `{ entryId }` | read-only; does **not** mark read; up to 200 KB HTML |
| `markRead` | `markRead` | `PUT /entries/:id/read` | `mark_read` | `{ entryId }` | idempotent |
| `markUnread` | `markUnread` | `DELETE /entries/:id/read` | `mark_unread` | `{ entryId }` | idempotent |
| `markAllRead` | `markAllRead` | `POST /entries/read` | `mark_all_read` | `{ feedId?, upTo }` | `upTo` = `asOf` from `list_entries` |

Errors: `lib/reader.ts` throws or returns `{ code, choices? }`; an action
returns it, `/api/v1` answers `404`/`422` with it, an MCP tool returns
`isError: true` with the JSON `{ code, message, choices? }` as text, so a
model can finish a `multiple` discovery by calling `subscribe` again with
one of `choices`. Others' data is `not_found` on all three. No MCP
resources or prompts in v1.

**Routes it adds** (all better-auth endpoints mount under the existing
`app/api/auth/[...all]`, issuer `<BETTER_AUTH_URL>/api/auth`: `/oauth2/*`,
`/jwks`, and the issuer-path discovery documents):

| File | Serves |
| --- | --- |
| `app/.well-known/oauth-protected-resource/[[...path]]/route.ts` | RFC 9728 metadata at the root and at `…/api/mcp` (`auth.handler`) |
| `app/.well-known/oauth-authorization-server/[[...path]]/route.ts` | RFC 8414 metadata at `/.well-known/oauth-authorization-server/api/auth` (`oauthProviderAuthServerMetadata(auth)`) |
| `app/api/mcp/route.ts` | the MCP endpoint |
| `app/consent/page.tsx` | the consent screen |

**Sign in with Vercel inside the MCP flow.** The client opens
`/api/auth/oauth2/authorize`; without a session the provider sends the
browser to `/sign-in?<signed query>`; the existing button works once
`lib/auth-client.ts` adds `oauthProviderClient()`, which carries the query
through the Vercel round trip; after the callback the provider resumes the
authorize request and goes to `/consent`. The registration gate holds
unchanged: a new account while closed ends on
`/sign-in?error=signup_disabled` and the client never gets a code. MCP
grants never carry admin rights.

**Client registration: CIMD only in v1.** A client's `client_id` is the
HTTPS URL of its metadata document (the 2026-07-28 spec's way; DCR is
optional and deprecated there). Dynamic client registration stays off: it
would be an anonymous database-write endpoint with only per-instance rate
limits and a cleanup job. If a named client the owner uses (Claude Code,
Cursor, …) fails the by-hand check because it only does DCR, turning it on
is two flags in `mcp()` plus an unused-client cleanup; that would be a
follow-up, not v1.

**Consent screen** (`/consent`, server page, `notFound()` unless
`verifyOAuthQueryParams` passes; no session → `/sign-in` with the same
query). One `Card`: **Allow {client_name} to use rssify?** · "{client uri
host} wants to reach your rssify account." Then one line per requested
scope, every scope in the verified query shown, nothing accepted that is
not shown:

- `reader`: "Read your feeds and entries, add and remove feeds, and mark
  entries read or unread."
- `offline_access`: "Stay connected until you disconnect it in Settings."

[Deny] [Allow] → `authClient.oauth2.consent({ accept })`, then the
returned redirect. Consent is never skipped. The OIDC identity scopes
(`openid`, `profile`, `email`) are not offered (§9), so there are no
identity claims to show.

**Settings → Connected apps** (a fourth `Card`, under API keys): "Apps
that use rssify through MCP." `Table`: Name, Website, Connected, and
[Disconnect]. Empty: **No connected apps** · "Add rssify to an MCP client
with the address {BETTER_AUTH_URL}/api/mcp." Disconnect: **Disconnect
{name}?** · "It loses access within an hour, and has to ask again to come
back." · [Disconnect]; toast "Disconnected {name}". `lib/mcp-clients.ts`
`listConnectedApps(userId)` and `disconnectApp(userId, clientId)` (deletes
the consent and revokes that client's refresh tokens in one transaction;
better-auth's own delete-consent does not touch tokens).

**Cleanup.** At the end of each cron run, `lib/auth-cleanup.ts` deletes
expired `oauthRefreshToken`, `oauthAccessToken` and `oauthClientAssertion`
rows (three indexed `deleteMany` calls on `expiresAt`, a few ms). CIMD
clients are kept (one row per client app, not per user).

### 5.6 Other routes

- `app/api/auth/[...all]/route.ts`: better-auth.
- `app/api/cron/refresh/route.ts` (`GET`, `maxDuration = 300`): §6.2.
- `app/api/mcp/route.ts`, `app/.well-known/*`, `app/consent`: §5.5.
- `app/api/queues/refresh-feed/route.ts` (`POST`, `maxDuration = 60`):
  §6.3; no public URL (Vercel invokes it through the trigger).

## 6. Cron, queue and ingest

One function does the work: `refreshFeed(feedId)` in `lib/ingest/`. The
consumer, the local script and tests call it; the queue is only how Vercel
calls it once per due feed.

### 6.1 `vercel.json` (needed; whole)

The owner's belief does not hold today: `@vercel/queue` 0.8.0 and the SDK
docs configure App Router consumers only through `experimentalTriggers` in
`vercel.json`; the one framework integration is Nitro. Cron is registered
through `vercel.json` `crons`. `@vercel/schedules` is alpha-only (npm
`latest` is an empty 0.0.0, no docs page) and is not used. Queues is Beta,
so expect the trigger keys to be renamed before GA.

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

(`src/app/…` if the app uses `src/`.) `maxDuration` lives in route files.

### 6.2 Fan-out (cron route), the only claim

1. `CRON_SECRET` unset → `500` and log; header not exactly
   `Bearer ${CRON_SECRET}` → `401`.
2. Claim in one statement, which also schedules:
   ```sql
   UPDATE "Feed" SET "nextFetchAt" = now() + interval '30 minutes'
   WHERE id IN (
     SELECT id FROM "Feed" f
     WHERE f."nextFetchAt" <= now()
       AND EXISTS (SELECT 1 FROM "Subscription" s WHERE s."feedId" = f.id)
     ORDER BY f."nextFetchAt" LIMIT 500
     FOR UPDATE SKIP LOCKED)
   RETURNING id
   ```
   The 30 minutes are a lease: a lost message, a dead consumer or a failed
   send means the feed simply comes due again. A duplicate cron run finds
   nothing to claim. Gone feeds have `nextFetchAt = null` and are never
   claimed.
3. `send('feed-refresh', { feedId }, { idempotencyKey: \`${feedId}:${tick}\` })`
   for each id, 50 at a time with `Promise.allSettled`; `tick` is the run's
   start rounded down to 15 min. A failed send is logged and left to the
   lease. Stop sending at 240 s; the rest stay leased and come due again.
4. Returns `{ claimed, sent, failed }`.

Capacity: 500 per tick × 4 per hour = 2,000 feeds per hour.

### 6.3 Consumer (one message = one feed)

`handleCallback(async ({ feedId }) => refreshFeed(feedId, { skipIfFreshWithin: 120 }))`.

- The consumer does **not** claim; the fan-out already did. It skips (and
  acks) only when `lastFetchedAt` is within the last 2 minutes, which is
  what a duplicate delivery looks like. A missing feed is acked.
- `refreshFeed` writes all feed polling fields once, at the end, in one
  update. A database error before that write throws; the queue redelivers
  after 60 s (at most 3 deliveries), and the redelivery is not skipped
  because `lastFetchedAt` was not written.
- Source failures (HTTP, parse, plugin) are written to the feed row and the
  function returns normally, so the message is acknowledged. Backoff lives
  in Postgres, not in the queue.
- Two refreshes of one feed racing (a delivery after the lease ran out):
  entries cannot duplicate; the feed row is last writer wins, and both
  writes are valid states. Accepted.

### 6.4 What "due" means

| Outcome | `nextFetchAt` | Other writes |
| --- | --- | --- |
| 200 parsed, or 304 | now + 60 min | `failureCount = 0`, `status = ok`, `lastError = null`, `lastSuccessAt`, validators |
| 429/503 with `Retry-After` | now + max(backoff, Retry-After), ≤ 24 h | `failureCount++`, `lastError` |
| any other failure | now + backoff | `failureCount++`, `lastError`; `status = failing` once `failureCount ≥ 3` |
| 410 | `null` | `status = gone` |

Backoff `min(60 min × 2^failureCount, 24 h)`. Always conditional GET when
validators exist; never depend on it. `lastFetchedAt` is written on every
outcome. Cron every 15 min, so a feed is at most 15 min later than its
interval.

### 6.5 Fetching (`lib/ingest/safe-fetch.ts`)

One `safeFetch(url, { etag, lastModified, deadline })` for feeds, discovery
and plugins, on `undici` 8 with its own `Agent`:

- **URL rules** (every hop): `http:`/`https:`, ports 80/443 only, no
  credentials, ≤ 2,048 chars. A literal IP host is checked directly.
- **Before connecting**: the agent's `connect.lookup` resolves the host
  (all addresses), rejects the request if any address is not public
  (`ipaddr.js` 2: `range()` must be `unicast`; an IPv4-mapped IPv6 address
  is converted to IPv4 and checked as IPv4), and hands the validated
  address to the socket. The hostname stays the TLS `servername`, so
  certificate checks are unchanged. **After connecting**: the socket's
  `remoteAddress` is checked again (defence in depth).
- **Redirects**: `redirect: 'manual'`, ≤ 5 hops, rules re-checked per hop.
  The stored URL is not rewritten; discovery stores the final URL.
- **Deadline**: one `AbortSignal` for the whole operation, redirects
  included: 15 s for a feed fetch; a plugin run shares one 40 s deadline
  for its list and post pages.
- **Size**: 10 MB of decoded bytes, counted while streaming.
- **Decoding**: charset from `Content-Type` → BOM → XML prolog → UTF-8
  (`TextDecoder`).
- **Headers**: UA `rssify/1.0 (+https://github.com/IKatsuba/rssify)`, a
  feed-preferring `Accept`. Content-Type is not trusted; the body is
  sniffed (`{` JSON Feed, `<` XML).
- **Test seam**: `createSafeFetch({ lookup })`. Tests pass a fake resolver;
  production has no bypass flag or env.

### 6.6 Parsing, identity, sanitising, storage

- RSS/Atom/RDF: `@rowanmanning/feed-parser` 2. JSON Feed: `JSON.parse` +
  our mapping (check `version`/`items`; `content_html`, else
  `content_text` **escaped** into `<p>`; `summary`; `date_published`).
- Entry: `{ guid, url, title, author, publishedAt, summary, contentHtml }`.
  `guid` = parser id ?? absolute url ?? sha1(title + publishedAt).
  `publishedAt` null when absent or bad, never "now". Title fallback:
  first 80 chars of summary, else "(untitled)".
- **Outward links**: `Entry.url` and `Feed.siteUrl` are resolved to
  absolute and kept only if `http:`/`https:`; otherwise `null`.
- **Sanitise once, at ingest**, with `sanitize-html` 2: its defaults plus
  `img figure figcaption picture source video audio`; attributes `href src
  alt title width height`; schemes `http https mailto`; no `style`, `on*`,
  `iframe`, `srcset` (dropped in v1). Relative `href`/`src` made absolute;
  every `<a>` gets `rel="noopener noreferrer nofollow" target="_blank"`.
  `contentHtml` ≤ 200 KB; `summary` is plain text ≤ 300 chars. The reader
  renders `contentHtml` as is. Images are hot-linked.
- **Store**: the newest 100 items of a fetch (by `publishedAt`, then
  document order) with `createMany({ skipDuplicates: true })` on
  `(feedId, guid)`. **First version wins**: a repeat is not updated.
  `sortAt = min(publishedAt ?? now, now)`, `createdAt` = first seen; read
  marks are never touched.
- **Retention**: after storing, the same `refreshFeed` deletes entries past
  the newest 500 of that feed by `(sortAt, id)`. Because each fetch only
  takes its newest 100, a pruned entry (older than 500 stored ones) is
  never re-taken.

### 6.7 Adding a feed (synchronous)

`subscribe` (action and API) in `lib/reader.ts`:

1. Over the per-user cap (500 subscriptions) → `limit`.
2. `{ source }` → the built-in descriptor's URL (§7). Normalise the URL.
3. A `Feed` with that URL exists → upsert the `Subscription`, done. **No
   fetch** (it is polled on its schedule).
4. Else fetch (`safeFetch`, 15 s). A feed body → parse. HTML → discovery:
   `<link rel~=alternate>` of RSS/Atom/JSON Feed types (`cheerio` 1); one →
   fetch and parse it; several → `multiple` with `choices`; none →
   `not_found`. No path guessing. The final URL is checked against existing
   feeds again (step 3).
5. Parsed → one transaction: insert the `Feed` (`ON CONFLICT (url) DO
   NOTHING`, read back), its first entries, the success polling fields, and
   the `Subscription`. Any failure → its code, **nothing written**.

A plugin source runs its plugin the same way (≤ 40 s). Unsubscribe deletes
the `Subscription`, and in the same transaction the `Feed` (cascading
entries and read marks) when no subscription is left. `deleteUser` does
the same for that user's feeds left without subscribers.

## 7. Source plugins and built-in sources

Two separate things:

```ts
// sources/builtin.ts: what the add dialog lists and { source } maps
export const builtinSources = [
  { id: 'claude-code', title: 'Claude Code blog', url: 'https://claude.dev/rss.xml', note: 'claude.dev — the Claude Code blog's own feed' }, // O1 (a)
  { id: 'cursor-blog', title: 'Cursor blog', url: 'https://cursor.com/blog', note: 'No feed of its own' },
] as const;

// sources/types.ts: a scraper for a site without a feed
export interface SourcePlugin {
  id: string;        // stored on Feed.pluginId
  matches: string;   // the list-page URL; Feed.url for its feed
  fetchEntries(ctx: { fetch: SafeFetch; known(urls: string[]): Promise<Set<string>>; deadline: AbortSignal }): Promise<IngestedEntry[]>;
}
// sources/index.ts
export const plugins: Record<string, SourcePlugin> = { 'cursor-blog': cursorBlog };
```

- A URL equal to a plugin's `matches` gets `pluginId`; `refreshFeed` calls
  the plugin instead of fetch + parse; sanitise, store, retention and
  backoff are the same path. Registering a plugin is a code change.
- Feed rows are created lazily on first subscribe; nothing is seeded.
- **`cursor-blog`** (cursor.com/blog, still server-rendered; measured in
  `drafts/ingest.md` §6): each `article`, link from
  `article.closest('a') ?? article.querySelector('a')`, only `/blog/`
  hrefs, de-duplicated. For URLs `known()` does not have (≤ 10 per run, 4
  at a time): title `og:title` minus " · Cursor"; summary
  `meta[name=description]`; content the first `.prose--blog`; date
  `article:published_time` → `time[datetime]` → list date; guid the URL. 0
  posts → failure "the page layout changed".
- **Claude Code**: `claude.com/blog` now redirects to `/resources/articles`
  and the old selectors match nothing; the Claude Code blog publishes real
  RSS at `https://claude.dev/rss.xml`. Default: plain feed, no plugin
  (owner answer O1).
- **No headless browser in v1**: every field of both sources is in the
  static HTML. Astral, deno-dom, Turndown and Redis go with Deno; entries
  are stored as sanitised HTML, not Markdown.

## 8. Prisma schema

Prisma 7.10.1 (npm `latest` is an 8.0 RC; pinned to the last stable),
`prisma-client` generator, connection in `prisma.config.ts`. The auth
models are what better-auth 1.7.12 and `@better-auth/api-key` 1.7.12
declare; the ship team runs `bunx @better-auth/cli generate` and the CLI's
output wins for those models.

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
// The FK on referenceId is ours, so deleting a user deletes their keys.

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

enum FeedStatus {
  ok
  failing
  gone
}

model Feed {
  id       String  @id @default(cuid())
  url      String  @unique // normalised feed URL, or the plugin's list page
  pluginId String? // null = RSS/Atom/JSON Feed
  title    String?
  siteUrl  String? // http(s) only, else null

  status        FeedStatus @default(ok)
  nextFetchAt   DateTime?  @default(now()) // null = stopped (gone)
  lastFetchedAt DateTime?
  lastSuccessAt DateTime?
  etag          String?
  lastModified  String?
  failureCount  Int        @default(0)
  lastError     String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  entries       Entry[]
  subscriptions Subscription[]

  @@index([nextFetchAt])
}

model Entry {
  id          String    @id @default(cuid())
  feedId      String
  feed        Feed      @relation(fields: [feedId], references: [id], onDelete: Cascade)
  guid        String
  url         String? // http(s) only, else null
  title       String
  author      String?
  summary     String? // plain text, ≤ 300 chars
  contentHtml String? // sanitised at ingest, ≤ 200 KB
  publishedAt DateTime?
  sortAt      DateTime // min(publishedAt ?? createdAt, createdAt)
  createdAt   DateTime  @default(now()) // first seen

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

For MCP (§5.5), the models that `jwt()` and `@better-auth/oauth-provider`
1.7.12 (through `@better-auth/mcp`) declare, read from the 1.7.12 package
source (`drafts/state.md` §7.1). `@better-auth/cimd` adds no table (CIMD
clients are `oauthClient` rows with `clientDiscoveryId = "cimd"`). The
CLI output wins here too. `User` gains `oauthClients`,
`oauthRefreshTokens`, `oauthAccessTokens`, `oauthConsents`; `Session`
gains `oauthRefreshTokens`, `oauthAccessTokens`. Deleting a user
cascades to their consents and tokens. MCP access tokens are JWTs and are
not stored.

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

- Shared `Feed`/`Entry`; per-user `Subscription`/`ReadMark` (no row =
  unread).
- List: `(sortAt desc, id desc)` with a keyset cursor. Unread counts: one
  grouped anti-join over the user's feeds. Neighbours for `j`/`k`: the same
  keyset, anchored on the open entry's `(sortAt, id)`.
- Mark all read: `INSERT … SELECT … ON CONFLICT DO NOTHING` for entries in
  scope with `createdAt <= upTo` (`upTo` = the list's `asOf`).
- Storage estimate: feed HTML is typically 5–20 KB per entry (measured
  range in the ingest draft), so 100 feeds × 500 entries ≈ 0.25–1 GB at
  the limit; the 200 KB cap is a ceiling, not the norm. Read marks are
  bounded by entries through the cascade. O4: the owner upgrades the
  Neon plan if it runs short.
- Migrations are additive in v1; dropping or renaming takes two releases.

## 9. Auth and API keys

`lib/auth.ts` (better-auth 1.7.12):

```ts
export const auth = betterAuth({
  database: prismaAdapter(db, { provider: 'postgresql' }),
  socialProviders: {
    vercel: { clientId: process.env.VERCEL_CLIENT_ID!, clientSecret: process.env.VERCEL_CLIENT_SECRET! },
  },
  session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
  databaseHooks: { user: { create: { before: registrationGate } } },
  disabledPaths: ['/token'], // jwt()'s session-to-JWT endpoint; not needed
  plugins: [
    jwt(),
    mcp({
      loginPage: '/sign-in',
      consentPage: '/consent',
      resource: MCP_RESOURCE, // `${BETTER_AUTH_URL}/api/mcp`
      scopes: ['offline_access', 'reader'],
      resources: [{ identifier: MCP_RESOURCE, name: 'rssify MCP', allowedScopes: ['offline_access', 'reader'] }],
      clientRegistrationDefaultScopes: ['offline_access', 'reader'],
      // DCR stays off (allowDynamicClientRegistration unset): CIMD only, §5.5
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    apiKey({ defaultPrefix: 'rss_', rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 } }),
    nextCookies(),
  ],
});
```

- **Sign in with Vercel**: better-auth's built-in `vercel` provider (PKCE,
  `openid email profile` set on the Vercel App). No generic OAuth plugin,
  no email/password. Callback `<BETTER_AUTH_URL>/api/auth/callback/vercel`.
  Env: `VERCEL_CLIENT_ID`, `VERCEL_CLIENT_SECRET`, `BETTER_AUTH_SECRET`,
  `BETTER_AUTH_URL`. A Vercel App holds a list of "Authorization Callback
  URLs" (Vercel docs, sign-in-with-vercel/authorization-server-api), so one
  App can serve both, but the owner chose two Apps (O6): a dev App with
  the `http://localhost:3210/api/auth/callback/vercel` callback, whose id
  and secret go in `.env.local`, and a production App whose credentials
  live only in Vercel's env.
- **Registration switch**: `registrationGate` in
  `databaseHooks.user.create.before`, on every user creation. Open
  (`REGISTRATION_ENABLED === 'true'`) → allow. Closed → allow only a
  verified email equal to `ADMIN_EMAIL` (case-insensitive); else throw
  `APIError('FORBIDDEN', { code: 'signup_disabled' })`. The OAuth callback
  redirects to `errorCallbackURL` (`/sign-in`) with
  `?error=signup_disabled`; no row is written. Existing users are never
  locked out. Not the provider's `disableSignUp`: it cannot exempt the
  admin, so a fresh deploy could never get its first account.
- **Admin**: never stored. `isAdmin(user)` = verified email equals
  `ADMIN_EMAIL`. `requireAdmin()` guards `/admin` and each admin action.
  Beyond a user the admin can: sign in while registration is closed; see
  `/admin`; delete a user. Nothing else. No better-auth admin plugin.
  `ADMIN_EMAIL` unset → no admin.
- **MCP** (§5.5): `jwt()` + `mcp()` + `cimd()`, one custom scope `reader`
  (every tool requires it) plus `offline_access`. The OIDC identity
  scopes are not offered; if the provider turns out to require `openid`
  for the flow, it is added and the consent screen shows "Know your name
  and email address." for it. No new env: the resource comes from
  `BETTER_AUTH_URL`; the signing key lives in `jwks`, encrypted with
  `BETTER_AUTH_SECRET` (which must stay stable). `localhost` HTTP is
  accepted as a resource locally only.
- **Who is calling** (`lib/actor.ts`):
  - `/api/v1`: only `x-api-key`. `auth.api.verifyApiKey({ body: { key } })`
    returns `{ valid, error, key }`: `valid === false` → `401`, or `429`
    (with `Retry-After`) when the error is the plugin's rate-limit code;
    otherwise the actor is `{ userId: key.referenceId, isAdmin: false }`.
    No header → `401`.
  - `/api/mcp`: `x-api-key` exactly as `/api/v1`; otherwise
    `requireMcpAuth` (JWT for this resource with `reader`), then the user
    must exist. Never admin.
  - Pages and actions: `auth.api.getSession({ headers })` only;
    `enableSessionForAPIKeys` stays false, so a key is never a session.
- **What an API key reaches**: its owner's reader data in `/api/v1` and
  `/api/mcp` (subscriptions, entries, read state, add/remove) and nothing
  else; an MCP OAuth grant reaches exactly the same; not
  key management, not admin, even for the admin's own keys. All keys have
  the same rights; read-only keys are later.
- **Rate limits**: 120 requests/min per key in the `apikey` row (the
  plugin's default is 10 per day). better-auth's own limiter stays at its
  default. 500 subscriptions per user (`limit`).

## 10. Local stack, config and deploy

- **Init** (unit 1): `bunx --bun shadcn@latest init --preset b1D0dxmC
  --template next --pointer`; bun is the package manager. Dev server on
  **3210** (`"dev": "next dev -p 3210"`).
- **Postgres**: docker compose, `postgres:17-alpine`, host port **54329**
  bound to loopback, trust auth (no password written anywhere), dev DB
  `rssify`, test DB `rssify_test`.

```yaml
services:
  postgres:
    image: postgres:17-alpine
    ports:
      - '127.0.0.1:54329:5432'
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

`docker/postgres-init.sql`: `CREATE DATABASE rssify_test;`.

- **Client** (`lib/db.ts`): one `PrismaClient` per instance on
  `globalThis`; `PrismaNeon` when the host ends in `.neon.tech`, else
  `PrismaPg`. No Rust engine in Prisma 7; no `ws` unless a build needs it.
- **`prisma.config.ts`**: `datasource.url: process.env.DATABASE_URL_UNPOOLED
  ?? process.env.DATABASE_URL` (plain `process.env`, because Prisma's
  `env()` throws when a variable is unset). The CLI runs through bun
  scripts, which load `.env`/`.env.local`.
- **`.env.example`** (names; defaults only where not secret):
  `DATABASE_URL=postgresql://rssify@localhost:54329/rssify`,
  `DATABASE_URL_UNPOOLED` (unset locally), `TEST_DATABASE_URL=postgresql://rssify@localhost:54329/rssify_test`,
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=http://localhost:3210`,
  `VERCEL_CLIENT_ID`, `VERCEL_CLIENT_SECRET`, `ADMIN_EMAIL`,
  `REGISTRATION_ENABLED=false`, `CRON_SECRET`. Queue credentials come from
  Vercel's OIDC on deploy; none locally.
- **Migrations**: `bunx prisma migrate dev` locally, committed.
  `"vercel-build": "prisma generate && if [ \"$VERCEL_ENV\" = production ] || [ \"$VERCEL_ENV\" = preview ]; then prisma migrate deploy; fi && next build"`:
  a failed migration fails the build. Each preview has its own Neon branch
  through the Neon–Vercel integration and migrates it (O3); previews have
  no sign-in in v1 (no callback is registered for preview URLs, so the
  button ends on the sign-in error state).
- **Queue and cron locally**: neither runs locally (crons do not run under
  `next dev`; the queue SDK needs `vercel link`/`env pull`, which are the
  owner's). `bun scripts/refresh.ts` runs a whole cycle against the docker
  DB: `fanOut((id) => refreshFeed(id))`, the same claim and refresh with no
  queue. Adding a feed already fetches it inline.
- **Deploy** (the owner's): Neon via the Vercel integration
  (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`), the Vercel App(s), the env
  variables above, `CRON_SECRET`.

## 11. Failure cases

| Case | Behaviour |
| --- | --- |
| Malformed / truncated feed | partial items stored if the parser returns them; a throw → failure "the response wasn’t a feed" |
| HTML instead of a feed | add: discovery; refresh: failure |
| Empty channel | success, 0 entries ("No entries yet") |
| Over 10 MB | abort, failure |
| Wrong encoding | decoded by §6.5 rule |
| 301/308 | followed (≤ 5), stored URL kept |
| 410 | `status = gone`, `nextFetchAt = null`, "This feed has stopped" |
| 404 / 5xx / DNS / timeout / 403 | backoff to daily; `failing` after 3; never stops |
| 429/503 + `Retry-After` | honoured, ≤ 24 h |
| Private / local address, redirect to one, DNS rebinding | rejected before connecting (and after) → `blocked` / "the address isn’t allowed" |
| `javascript:` or relative entry/site link | stored as `null`; Open original disabled |
| Hostile HTML in content | sanitised at ingest |
| Message delivered twice | second skips (fetched < 2 min ago); entries cannot duplicate |
| Consumer DB error | throws; redelivered after 60 s, ≤ 3 times; then the lease |
| Consumer timeout | queue retry; then the lease (30 min) |
| Cron missed / duplicated | next tick takes the backlog / claim finds nothing |
| Send fails in fan-out | logged; the lease brings the feed back |
| Plugin layout changed | 0 posts → failing "the page layout changed" |
| Site needs a browser | not supported in v1; shows failing |
| Add: first fetch fails | error code in the form; nothing written |
| Two users add one new URL at once | `ON CONFLICT (url)`; both subscribe to the same row |
| Last subscriber leaves | feed and its entries deleted in the same transaction |
| Mark read on a pruned entry | FK error → `404` |
| Mark-read on open vs `m` toggle | client chains them; last intent wins |
| Registration closed, new account | `/sign-in?error=signup_disabled`, no rows |
| Unverified email equal to `ADMIN_EMAIL` | not admin; refused when closed |
| Key revoked / expired / invalid | `401`; over the limit `429` |
| `CRON_SECRET` unset | cron route refuses (`500`), nothing claimed |
| Production migration fails | build fails; old deployment keeps serving |
| MCP access token expires | 401 with the challenge; the client refreshes |
| App disconnected | refresh tokens revoked at once; an issued access token works until it expires (≤ 1 h) |
| User deleted | consents and tokens cascade; the next MCP call fails the user check → 401 |
| CIMD document unreachable or invalid | authorize fails closed; no client row written |
| Client that only does DCR | cannot connect in v1; follow-up turns DCR on (§5.5) |
| JWKS self-fetch fails on a cold instance | 500; the client retries |
| `BETTER_AUTH_URL` wrong on a deploy | `aud`/`iss` mismatch → every MCP call 401; caught by the by-hand check |
| Database unreachable | pages show `error.tsx`; consumer retries |

## 12. Test plan

**Runner: `bun test`** (built in; runs files serially, which suits one test
DB). No component tests; screens checked by hand. Keep `server-only`
imports out of `lib/` (or alias in `bunfig.toml`).

- **Test DB**: `"test": "DATABASE_URL=$TEST_DATABASE_URL DATABASE_URL_UNPOOLED=$TEST_DATABASE_URL bunx prisma migrate deploy && DATABASE_URL=$TEST_DATABASE_URL DATABASE_URL_UNPOOLED=$TEST_DATABASE_URL bun test"`.
  `test/db.ts` refuses to run (throws before truncating) unless the URL's
  host is `localhost`/`127.0.0.1` and its database is `rssify_test`;
  `beforeEach` truncates all tables except `jwks` (one signing key per test process, so the verifier's 5-minute JWKS cache never sees a vanished key; rotation has its own test). Users are inserted directly; keys via
  `auth.api.createApiKey({ body: { userId } })`.
- **No test touches Neon, Vercel, the queue or the internet.** Two kinds:
  offline fixture tests (bytes in, entries out) and local-network tests
  (sockets on 127.0.0.1 only, for safe-fetch).
- **Fixtures**: synthetic, hand-written with invented content and example
  domains, keeping only the structure the code reads, plus hostile-HTML,
  `javascript:`-link, null-link, `content_text` with `<tag>`, and truncated
  copies.

| Area | Cases |
| --- | --- |
| safe-fetch | literal private/loopback/link-local/metadata IPs; a fake `lookup` returning a private address; mixed public+private answers; IPv4-mapped public and private; redirect to a private address; > 5 redirects; deadline across slow hops; 10 MB cap; ports; charset rule |
| parse | each fixture; JSON Feed `content_text` escaped; guid fallbacks; bad dates null; sanitiser strips script/on*/javascript:, drops srcset, absolutises, adds rel |
| refreshFeed | 200, 304, 410, 429 + Retry-After, failure → backoff and `failing` at 3, success resets; first version wins; newest 100 only; retention keeps 500; skip when fetched < 2 min; DB error throws without writing `lastFetchedAt` |
| fan-out → consumer | claim takes only due, subscribed, non-gone feeds; two concurrent claims split; claimed feed then consumer refreshes it (the real sequence); redelivery after a throw refreshes; failed send leaves the lease |
| subscribe | existing feed → no fetch; new feed → one transaction; first-fetch failure writes nothing; `multiple` choices; built-in `source`; plugin match; concurrent adds; cap 500 |
| reader | lists, keyset paging with equal `sortAt`, unread filter, counts, neighbours, mark read/unread idempotent, mark-all `upTo`, unsubscribe deletes the orphan feed, 404 for others' feeds/entries/subscriptions |
| auth | `isAdmin`; gate open/closed/admin/unverified admin; `ADMIN_EMAIL` unset |
| actor and `/api/v1` | valid key; no header; invalid, revoked, expired → 401; 121st call → 429; a valid session cookie without a key → 401; deleting another user's subscription → 404; response shapes |
| actions | each action without a session redirects; `deleteUser` as non-admin refused; admin cannot delete self |
| cron route | missing secret env → refuse; wrong header → 401 |
| cursor-blog | list and post fixtures; off-site and duplicate links dropped; 0 posts → failure |
| MCP route | no credentials → 401 with `resource_metadata`; `Bearer not-a-jwt`, foreign key, wrong `aud`, wrong `iss`, expired, no `azp` → 401; no `reader` → 403 `insufficient_scope`; token of a deleted user → 401; `?access_token=` ignored; `Bearer rss_…` → 401; `x-api-key` revoked/expired → 401, 121st → 429; foreign `Origin` → 403 |
| MCP tools | `tools/list` is the eight; 2025-era `initialize` answered statelessly; each tool with a token and with a key; `get_entry` of another user → `not_found`, and does not mark read; `subscribe` `multiple` returns `choices` and a second call with one subscribes |
| parity | one scenario (incl. `multiple`) through an action, `/api/v1` and MCP gives the same data |
| OAuth | real tokens minted in process: a user + session, its cookie headers passed to `adminCreateOAuthClient` with `application_type: 'native'`, `token_endpoint_auth_method: 'none'`, redirect `http://127.0.0.1:9/cb`, scopes `offline_access reader`; authorize (PKCE, `resource`) → consent → token; bad tokens signed with `jose` from a test key; the JWKS self-fetch answered in process by `auth.handler`, any other URL throws |
| well-known | protected resource metadata at both paths (`resource`, `authorization_servers`, `scopes_supported`); RFC 8414 metadata (`S256`, CIMD supported, no `registration_endpoint`) |
| connected apps | disconnect deletes the consent and revokes that client's refresh tokens only; cleanup deletes expired token rows only |
| UI pure parts | key → action map; `canHandleKey` with input focus, open dialog, modifiers, switch off; error code → sentence table |

**CI**: GitHub Actions, one job with a `postgres:17-alpine` service:
`bun install`, `prisma generate`, lint, `tsc --noEmit`, `bun run test`,
`bun run build` with dummy env values. No secrets.

**HTTP smoke** (once, against `next start` on 3210 locally): the two root `/.well-known/…` URLs answer through the optional catch-all, and `GET`/`DELETE /api/mcp` give `405`.

**By hand** (local, port 3210): `claude mcp add --transport http rssify http://localhost:3210/api/mcp`, then sign in through Vercel, consent, list/read/mark and see the UI agree; the same with a fresh account while registration is closed; with `--header "x-api-key: …"`, no browser; disconnect in Settings; the MCP Inspector against the same URL; Cursor too (if it only does DCR, note it for the DCR follow-up, §5.5); sign in through the dev Vercel callback;
registration closed with a fresh account; `/admin` as admin and 404 as
not; API key with `curl -H 'x-api-key: …' localhost:3210/api/v1/subscriptions`
then revoke; subscribe to a real feed and both built-ins; `bun
scripts/refresh.ts`; read, keys, two tabs.

## 13. Build units, in order

Each unit is one shippable change with its tests.

1. **Foundation.** Remove Deno (`main.ts`, `main_test.ts`, `lib/`,
   `providers/`, `deno.json`, `deno.lock`, `Dockerfile`, the Redis
   compose, `.zed` deno config if it no longer applies). Init Next.js with
   the preset (dev port 3210). `docker-compose.yml` + init SQL,
   `.env.example`, Prisma 7 + `prisma.config.ts` + `lib/db.ts` + the full
   schema and first migration, `vercel-build`. better-auth with the Vercel
   provider, `registrationGate`, `isAdmin`, the API key plugin,
   `app/api/auth/[...all]`. `/sign-in` with its four states and a
   signed-in placeholder. `bun test` + `test/db.ts` + auth tests. Rewrite
   CLAUDE.md for the new stack.
2. **Reader core** (`lib/reader.ts`, `lib/actor.ts`): list, counts,
   neighbours, mark, unsubscribe (with orphan delete), subscribe for
   existing feeds. Tests.
3. **safe-fetch.**
4. **Parse, normalise, sanitise.**
5. **`refreshFeed`** with storage, due/backoff, retention.
6. **Add feed**: discovery, built-in sources, the new-feed transaction.
7. **Refresh loop**: `fanOut`, `scripts/refresh.ts`, cron route, consumer
   route, `vercel.json`, `@vercel/queue`.
8. **`cursor-blog` plugin** and `sources/builtin.ts`.
9. **Reader UI, read-only**: layout, sidebar, lists, entry, every state,
   `min-w-0`, reduced motion, `@tailwindcss/typography` (`prose
   dark:prose-invert`, O5).
10. **Reader actions UI**: mark, mark all, add dialog, unsubscribe, toasts.
11. **Keys**: listener, guard, cursor, `?` dialog, tooltips, switch, `d`.
12. **Settings, API keys UI and `/api/v1`**, on `lib/reader-schemas.ts` (the zod inputs shared by actions, API and MCP).
13. **OAuth provider for MCP**: `jwt()`, `mcp()`, `cimd()`, `oauthProviderClient()`, the schema additions and migration, the two `app/.well-known` routes, `/consent`, the user-exists check, `lib/mcp-clients.ts` and Settings → Connected apps, `lib/auth-cleanup.ts` in the cron route; tests.
14. **MCP server**: `lib/mcp/server.ts` with the eight tools, `app/api/mcp/route.ts` (OAuth and `x-api-key`); route, tool and parity tests.
15. **Admin.**
16. **CI.**

Dependencies added: `next`, `react`, shadcn preset deps, `better-auth`,
`@better-auth/api-key`, `prisma`, `@prisma/client`, `@prisma/adapter-neon`,
`@prisma/adapter-pg`, `@vercel/queue`, `@rowanmanning/feed-parser`,
`sanitize-html`, `cheerio`, `undici`, `ipaddr.js`, `@better-auth/mcp`, `@better-auth/cimd`, `@modelcontextprotocol/server`, `zod` 4, and `@tailwindcss/typography` (dev).

## 14. Decisions, with the options considered

| Decision | Options | Chosen, and why |
| --- | --- | --- |
| Queue config | Next.js native integration; `vercel.json` `experimentalTriggers` | `vercel.json`: the only App Router path in `@vercel/queue` 0.8.0 and the docs |
| Cron registration | `vercel.json` `crons`; `@vercel/schedules` | `crons`: schedules is alpha with no docs |
| Cron cadence (Pro) | `*/5`; `*/15`; hourly | `*/15`: a feed is ≤ 15 min late; `*/5` keeps Neon awake around the clock; the owner keeps `*/15` and upgrades Neon if needed (O4) |
| Polling | fixed interval + backoff; adaptive (ttl, Cache-Control) | fixed 60 min + exponential backoff to 24 h, stop on 410 |
| Claim | fan-out claim; consumer claim; both | fan-out only (lease 30 min); consumer skips duplicates by `lastFetchedAt`. Both together never fetched |
| Local/test queue | fake queue; `vercel dev` broker; function seam | function seam (`fanOut(enqueue)`, `refreshFeed`): nothing to maintain, no `vercel link` |
| Parser | rowanmanning; feed-extractor; feedsmith | rowanmanning + own JSON Feed mapping: keeps HTML, honest ids, resolves `xml:base` |
| Sanitising | at render; at ingest | at ingest with `sanitize-html` (no jsdom), once per shared entry |
| Repeated entry | update; first version wins | first version wins: one `createMany`; corrections are later |
| Add flow | enqueue first poll; synchronous | synchronous: errors at the form, entries at once, nothing written on failure; existing feeds not re-fetched |
| Data model | per-user feeds; shared feeds + per-user subs/read marks | shared: one fetch per URL whoever subscribes |
| Orphan feeds | keep; delete on last unsubscribe | delete: bounds storage, no cleanup job |
| Admin | better-auth admin plugin; computed from env | computed: no role columns; three powers only |
| Registration | provider `disableSignUp`; user-create hook | hook: exempts the admin so a fresh deploy can bootstrap |
| API auth | key or session; key only | key only on `/api/v1`: no CSRF surface; the UI uses actions |
| Local DB driver | Neon WS proxy container; `PrismaPg` locally | `PrismaPg` locally, `PrismaNeon` on Neon, by host |
| Caching | Redis; `use cache`; none | none beyond Postgres and conditional GET |
| Headless browser | Astral/Chromium; hosted browser; none | none: both sources are static HTML |
| Built-ins | seeded rows; lazy rows | lazy on first subscribe; descriptors in code |
| SSRF | post-connect check; library; pre-connect lookup | pre-connect `lookup` validation + post-connect check; the libraries do not support undici fetch |
| Test runner | vitest; `bun test` | `bun test`: built in |
| Layout | three panes; one column | one column (list or entry) at every width |
| Hotkeys | library; own listener | own ~40-line listener with one guard |
| Retention | by age; by count | newest 500 per feed, pruned in `refreshFeed` |
| Ports | any; 80/443 | 80/443 only in v1: closes internal port probing |
| CI | none; GitHub Actions | GitHub Actions, no secrets |
| MCP server library | `mcp-handler`; SDK v1; SDK v2 `@modelcontextprotocol/server` | SDK v2 directly: maintained, Web-standard handler, stateless; `mcp-handler` 2.x wraps it |
| MCP auth | legacy `mcp` plugin; `@better-auth/mcp` (OAuth 2.1 provider) | `@better-auth/mcp`: the owner's requirement and better-auth's current path |
| API key on MCP | no; yes | yes: one branch, works with header-only clients and scripts |
| Client registration | CIMD + DCR; CIMD only | CIMD only: the current spec's way; DCR is an anonymous write endpoint, deferred until a named client needs it |
| MCP revocation | consent-row check per call; JWT expiry | JWT expiry (≤ 1 h) + refresh revoked at disconnect; user-exists check per call |
| Scopes | OIDC + `reader`; `reader` + `offline_access` | the latter: nothing on the consent screen the person cannot read |
| One implementation | per-surface code; `lib/reader.ts` + shared zod schemas | the latter, with a parity test |
| Entry read via API/MCP | marks read; does not | does not: a fetch never changes state; clients mark explicitly |

## 15. Critic findings and how each was resolved

1. Fan-out and consumer claims conflict — **accepted**: fan-out is the only
   claim; consumer skip rule and DB-error redelivery specified (§6.2–6.3).
2. Build swallowed migration failures — **accepted** (§10).
3. `env()` throws; tests could migrate the wrong DB — **accepted**:
   `process.env`, both URLs set, guard in `test/db.ts` (§10, §12).
4. Trust-auth port on all interfaces — **accepted**: `127.0.0.1` (§10).
5. SSRF check after connect only; IPv4-mapped — **accepted**: pre-connect
   `lookup`, mapped addresses converted, post-connect kept (§6.5).
6. Unsanitised `url`/`siteUrl` — **accepted**: http(s) only else null; UI
   disables links (§6.6, §2.3).
7. `status`/stop on 410 missing; names differ — **accepted**: one schema
   (§8), gone state and sentence (§4).
8. Update vs first-version-wins; 100 vs 500 — **accepted**: first version
   wins; 100 per fetch with the retention argument (§6.6).
9. Add flow contract — **accepted**: synchronous, nothing written on
   failure, existing feeds not re-fetched; UI sentence changed (§6.7, §4).
10. Time budgets — **accepted**: one deadline across redirects, plugin
    deadline, `maxDuration` on every path, fan-out stop at 240 s (§6).
11. Orphans and storage — **accepted**: orphan delete, 500-subscription
    cap, storage estimate (§6.7, §8); Neon plan: O4 (owner upgrades if short).
12. Built-in vs plugin registry — **accepted**: descriptors separate from
    plugins, lazy rows (§7); Claude scope: O1 (claude.dev/rss.xml).
13. Auth fail-closed branches and tests — **accepted**: key-only API,
    `valid === false` branches, `CRON_SECRET` unset refused, negative tests
    (§9, §12).
14. `content_text` and `srcset` — **accepted**: escaped; `srcset` dropped.
15. Test seam for safe-fetch — **accepted**: injected `lookup`, local
    sockets only, no production bypass (§6.5, §12).
16. Hotkey guards and mark-read race — **accepted in part**: one guard for
    our keys and `d`; mark-read chained. **Rejected** for `⌘B`: a
    modified chord, outside WCAG 2.1.4, and turning it off would mean
    editing the generated sidebar.
17. Routine choices handed to the owner — **accepted in part**: retention,
    CI, touch targets, ports and the admin screen are decided here.
    **Kept for the owner**: the Vercel App count (O6), because the owner
    creates and holds the Apps, and the typography dependency (O5),
    because the brief sends anything shadcn lacks up as a question. The
    finding's premise holds: one App can hold several callback URLs.

**Second round, on the MCP section (`drafts/state.md` §7):**

1. Consent-row check is not revocation (reconnect revives old tokens) —
   **accepted**: dropped; JWT expiry ≤ 1 h stated, refresh tokens revoked
   at disconnect, user-exists check kept.
2. Consent screen did not show OIDC scopes/claims — **accepted**: OIDC
   identity scopes not offered; every requested scope is shown.
3. Test client helper would be rejected — **accepted**: `native`, session
   cookie headers, explicit scopes (§12).
4. Truncating `jwks` breaks the verifier cache — **accepted** (§12).
5. M1 reopened API-key-only MCP against the owner's requirement —
   **accepted**: OAuth fixed; API key additionally, decided here.
6. DCR on without a named client — **accepted**: CIMD only, DCR a
   follow-up if a named client fails; its cleanup dropped.
7. Speculative root OIDC route; routing untested — **accepted**: route
   dropped; one HTTP smoke check; `OPTIONS` noted.
8. MCP errors lost `choices` — **accepted**: JSON error with `choices`,
   parity test covers `multiple`.

State also noted `DELETE /subscriptions/:id` vs the action's `feedId`:
fixed to `:feedId`.

## 16. Owner's answers

All as recommended (recorded on the board, RSSF-1):

- **O1 (a).** The built-in "claude-code" source is
  `https://claude.dev/rss.xml`, a plain feed; no Claude scraper plugin.
- **O2 (a).** The old public Atom output (`/:namespace/:route`) is dropped
  in v1. A public or per-user Atom export can come later without changing
  the model.
- **O3 (a).** A Neon branch per preview through the Neon–Vercel
  integration, migrated by the preview's build (§10). No sign-in on
  previews in v1.
- **O4.** The cron stays `*/15`. If Neon's plan runs short, the owner
  upgrades the plan rather than slowing the cron.
- **O5 (a).** `@tailwindcss/typography` for entry content (unit 9).
- **O6 (a).** Two Vercel Apps, development (localhost callback) and
  production; the owner creates them and holds the secrets (§9).

Also accepted as designed: fetching an entry through the API or MCP does
not mark it read; clients mark it explicitly (§5.4).

Nothing is left open for the owner. The questions as they were put are in
the history of this file.
