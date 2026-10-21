# RSSF-1 interface draft: screens, states, keys

Interface architect's answer to the brief's interface questions 1–6 and the
shared items. It also covers the owner's settled answers: multi-user, sign-in
only through Vercel, and an admin named by an env email. The model is the
one in `drafts/state.md` (shared `Feed`/`Entry`, per-user `Subscription` and
`ReadMark`, `@better-auth/api-key`, `/admin`). Anything the UI depends on is
flagged in the closing lists.

## 0. How the screens were made, and what the preset is

The captures under `drafts/interface/` are real renders. The shadcn/ui
components come from the owner's preset, and the screens are made of mock
data in a throwaway app outside the repository:

- The app is `/tmp/rss1-ui/app`, made with
  `bunx --bun shadcn@latest init --preset b1D0dxmC --template next --pointer`,
  and the components were added with `shadcn add`. Nothing was written to
  the repository but the PNGs and this file.
- The dev server ran on port 3917 and was stopped afterwards. The captures
  were taken by puppeteer-core 24 driving local Chrome, from a Deno script.
  Chrome's own `--headless --window-size` cannot go narrower than 500 px,
  so the phone captures use viewport emulation at 390×844.
- The mock source was not committed, so the PNGs are the record. Mark-up
  details in this file (class names, props) come from that mock and were
  checked by `tsc`.

What the preset turned out to be (from the generated `components.json` and
`package.json`):

| | |
| --- | --- |
| style | `base-mira`: primitives from **Base UI** (`@base-ui/react` 1.9.0), not Radix. Composition uses the `render` prop, not `asChild`. |
| colours | `neutral`, CSS variables, light and dark, with no accent: monochrome as asked |
| icons | `lucide` (`lucide-react`) |
| font | Geist and Geist Mono through `next/font/google` |
| stack | Next.js 16.4.0, React 19.3.0, shadcn 4.22.1, Tailwind 4, `next-themes` 0.4.6, `tw-animate-css` 1.4.0 |
| ships | `components/theme-provider.tsx`, which wraps `next-themes` and adds a **`d` hotkey** that toggles dark mode |

Two things the template already does, and which the design keeps:

- `ThemeProvider` binds `d`.
- `Sidebar` binds **⌘B / Ctrl+B** (`SIDEBAR_KEYBOARD_SHORTCUT = "b"` in
  `components/ui/sidebar.tsx`), and below 768 px it becomes a `Sheet`
  (`hooks/use-mobile.ts`, `MOBILE_BREAKPOINT = 768`).

## 1. Screens and their states

Routes (all App Router, under `app/`):

| Route | Who | What |
| --- | --- | --- |
| `/sign-in` | signed out | the one "Sign in with Vercel" button |
| `/` | user | **All feeds**: the entry list across subscriptions |
| `/feeds/[feedId]` | user | one feed's entries; 404 if not subscribed |
| `/entries/[entryId]` | user | one entry, with `?feed=<feedId>` and `?filter=all` carried from the list it came from |
| `/settings` | user | account, API keys, keyboard shortcuts |
| `/admin` | admin only | users and feeds (state §1); 404 for others, and no link to it |

The list routes take `?filter=all` (the default is unread) and
`?cursor=<opaque>` for older pages. Adding a feed is a dialog, not a route.
It opens from the sidebar's `+`, the empty state's button, or the key `a`.

All signed-in routes live in one route group, `app/(reader)/`, whose layout
renders the sidebar. A signed-out visit redirects to `/sign-in`.

### 1.1 Sign-in (`/sign-in`)

One `Card` holds the app name, one line under it, and one full-width
`Button`. There is no sign-up form, no email field and no other provider.

| State | When | Capture |
| --- | --- | --- |
| default | first visit, or after signing out | `desktop-signin.png`, `dark-signin.png` |
| redirecting | after the button is pressed, until the browser leaves for vercel.com: the button is disabled and shows a `Spinner` | `desktop-signin-redirecting.png` |
| registration closed | `?error=signup_disabled` | `desktop-signin-closed.png`, `phone-signin-closed.png` |
| sign-in error | `?error=<anything else>`, for example `access_denied` when the person cancels on Vercel | `desktop-signin-error.png` |

The button calls
`authClient.signIn.social({ provider: 'vercel', callbackURL: '/', errorCallbackURL: '/sign-in' })`.

- better-auth 1.7.12 sends every OAuth callback failure to
  `errorCallbackURL` with `?error=<code>&error_description=…`
  (`better-auth/dist/api/routes/callback.mjs`, `redirectOnError`).
- With `disableSignUp`, the code is `signup_disabled` (`"signup disabled"`
  with spaces made underscores; `dist/oauth2/link-account.mjs:257`).
- An `APIError` thrown from a hook is redirected with `e.body.code`
  (`callback.mjs:151`).

So state's hook must throw with code `signup_disabled` (state already says
so), and the page maps exactly that code to "registration closed". The
page is a server component that reads `searchParams.error`. Only the button
is a client component.

A signed-in visit to `/sign-in` redirects to `/`.

### 1.2 The reader: All feeds and one feed

The layout is the shadcn `Sidebar` beside a `SidebarInset`. The main column
shows either the entry list or one entry, never both. That is one layout at
every width (§6), and it is the simplest one that also works on a phone.

**Sidebar**

- At the top: "rssify".
- "All feeds", with the total unread count.
- The group "Feeds", with a `+` (`SidebarGroupAction`, "Add feed") and one
  `SidebarMenuButton` per subscription, with its unread count in
  `SidebarMenuBadge`. A count of 0 shows no badge. Feeds are sorted by
  title.
- A failing feed shows `TriangleAlert` instead of the `Rss` icon, and its
  title is muted. Its tooltip reads "Not updating — open for details".
- At the foot: the signed-in email, which opens a `DropdownMenu` with
  Settings, Keyboard shortcuts `?`, Admin (admin only), Theme (Light, Dark,
  System) and Sign out.

**List header**

- `SidebarTrigger` and the title.
- Two `Button`s, **Unread** and **All**. They are links to `?filter=`, and
  the current one is `variant="secondary"`.
- A "Mark all as read" icon button.
- On a feed's page only, a `…` `DropdownMenu`: Open website, Copy feed URL,
  Mark all as read `⇧A`, and **Unsubscribe…**, which is the destructive
  item.

**Rows**

- Each row is an `Item` rendered as a link, with three lines:
  - "Feed · 2h" (no feed name on a feed's own page);
  - the title, muted when read;
  - the summary, cut to two lines.
- The keyboard cursor is the row with `variant="muted"` and
  `aria-current="true"`.
- 50 rows per page. At the bottom there is an **Older entries** `Button`
  (a link with `?cursor=`), and **Newer entries** at the top when a cursor
  is set. There is no infinite scroll: paging stays server-rendered, and
  Back works.

| State | Sentences | Capture |
| --- | --- | --- |
| entries, unread filter | as above | `desktop-reader.png`, `wide-reader.png`, `dark-reader.png`, `phone-reader.png`, `phone-dark-reader.png` |
| entries, All filter (read rows muted) | | `desktop-reader-allfilter.png` |
| one feed, with its menu open | | `desktop-feed-menu.png` |
| **no feeds yet** | **No feeds yet** · "Add a feed by its URL, or start with one of the built-in sources." · [Add feed] | `desktop-reader-empty.png` |
| loading (`loading.tsx`) | `Skeleton` rows and `SidebarMenuSkeleton`; no text | `desktop-reader-loading.png` |
| **nothing unread** | **All caught up** · "Nothing unread. New entries show up here as your feeds update." · [Show all entries] | `desktop-reader-caughtup.png` |
| a feed with nothing under the filter | **No unread entries** · "Older entries from this feed are still under All." | in `desktop-feed-failing.png` |
| **feed just added, not fetched yet** | **Nothing here yet** · "We’re fetching this feed for the first time. Entries appear in a minute or two." · [Reload] | `desktop-feed-new.png` |
| **failing feed** | an `Alert` above the list: **This feed isn’t updating** · "Last updated 6 days ago. The last try failed: {lastError}. We’ll keep trying." | `desktop-feed-failing.png`, `dark-feed-failing.png`, `phone-feed-failing.png` |
| failing, never succeeded | **This feed isn’t updating** · "We haven’t been able to fetch it yet. The last try failed: {lastError}. We’ll keep trying." | (same layout) |
| page error (`error.tsx`) | **Couldn’t load your feeds** · "Something went wrong on our side. Try again in a moment." · [Try again] (`reset()`) | `desktop-reader-error.png` |
| unknown or unsubscribed feed (`not-found.tsx`) | **Feed not found** · "You aren’t subscribed to this feed." · [Back to All feeds] | (same `Empty` layout) |

Notes:

- The "failing" alert is the shadcn `Alert` in its default variant, with
  no red. Red (`destructive`) is kept for errors on the person's own
  actions.
- The capture says "once a day" in the alert. The design sentence drops
  the period, because ingest owns the backoff and the UI should not
  promise a schedule.
- "Failing" is state's `failing` (`failureCount >= 3`). The UI shows
  `lastError` as it is, so ingest must keep it short and readable (e.g.
  "the site answered 404 Not Found", "the response wasn’t a feed"). The
  "Last updated" time is `lastSuccessAt`.
- Times are relative in lists ("2h", "3d", from `Intl.RelativeTimeFormat`
  in the server render, no library). In the entry they are absolute
  ("Oct 21, 2026"). A `title` attribute on lists gives the absolute time.

**Mark all as read** (`desktop-markall.png`) is an `AlertDialog`:

- **Mark 37 entries as read?** · "Everything unread in {All feeds | feed
  title} up to now. Entries that arrive later stay unread." · [Cancel]
  [Mark as read].
- The count is the unread count of the scope, which is already on screen.
- The action sends state's `upTo = asOf` from the list query, so entries
  that arrive after the page was rendered stay unread.
- Afterwards a `sonner` toast says "Marked 37 entries as read". There is no
  undo.

**Unsubscribe** (`desktop-feed-remove.png`) is an `AlertDialog`:

- **Unsubscribe from {title}?** · "It leaves your sidebar, and its entries
  leave your lists. You can add it again later." · [Cancel] [Unsubscribe].
- Afterwards it goes to `/` with the toast "Unsubscribed from {title}".
- It says "unsubscribe", not "delete", because the feed is shared (state
  §1).

### 1.3 An entry (`/entries/[entryId]`)

The header holds:

- `SidebarTrigger`;
- **← {list name}** (Back, key `u`);
- ↑/↓ icon buttons (previous/next, `k`/`j`);
- **Mark as unread** / **Mark as read** (`m`), whose icon and label change
  with the state;
- **Open original** (`v`), with `target="_blank" rel="noopener"`.

Below 640 px the buttons drop their text and keep the icon. The text stays
for screen readers as `sr-only`.

The body is an `<article>`:

- the meta line "Feed · date · author", an `h1`, and the content;
- the content is in a `prose` container (§5, owner question 1), at most
  65ch wide and centred.

Captures: `desktop-entry.png`, `wide-entry.png`, `dark-entry.png`,
`phone-entry.png`.

| State | Sentences |
| --- | --- |
| content present | as above |
| no content, summary only | the summary, then a `Button` [Read on {site}] |
| neither | "This entry has no text. Read it on {site}." with the same button |
| entry pruned or unknown (`not-found.tsx`) | **This entry is no longer kept** · "We keep the newest 500 entries of each feed, and this one is older." · [← Back to All feeds] (`dark-entry-gone.png`) |
| loading | `Skeleton` title and three lines |

Opening an entry marks it read through a server action called from the
client on mount, **not** during the server render. Next.js prefetches links
(`next/link`), and a render that wrote a read mark would mark entries read
just because they scrolled into view. Entry links in the list also set
`prefetch={false}`, which saves the database work as well.

`j`/`k` on the entry page go to the next or previous entry *in the list it
came from*, using `?feed=` and `?filter=`. The server computes the two
neighbour ids with the same keyset query as the list, one row each way. At
the end of the list `j` does nothing, and the ↓ button is disabled.

### 1.4 Add a feed (dialog)

A `Dialog` titled **Add a feed**, with the line "Paste a feed URL or a
website’s address. We’ll find its feed." Under it:

- a `Field` labelled "URL" holding an `Input` (placeholder
  `https://example.com`) and an **Add** button;
- a `FieldSeparator`: "or pick a built-in source";
- one `Item` per source plugin, with a title, "claude.com/blog — no feed of
  its own", and a [Subscribe] button, or a `Badge` "Subscribed" when the
  person already follows it.

| State | Sentences | Capture |
| --- | --- | --- |
| default | as above | `desktop-add.png`, `dark-add.png`, `phone-add.png` |
| adding | Input and button disabled; button: `Spinner` "Adding…" | `desktop-add-adding.png` |
| several feeds found | "{host} has more than one feed. Pick one." with one `Item` per feed (title, URL, [Subscribe]) and [Back] | `desktop-add-choose.png` |
| nothing found | `FieldError`: "We couldn’t find a feed at that address. Try the site’s feed URL directly." | `desktop-add-error.png` |
| not a URL | `FieldError`: "That doesn’t look like a web address." | |
| site unreachable or timed out | `FieldError`: "We couldn’t reach {host}. Check the address and try again." | |
| blocked address (private or local, SSRF) | `FieldError`: "That address can’t be fetched from here." | |
| already subscribed | the dialog closes and goes to the feed; toast "You already follow {title}." | |
| added | the dialog closes and goes to `/feeds/[feedId]`; toast "Subscribed to {title}." The page shows "Nothing here yet" until the first poll lands. | |

The error codes come from ingest's discovery (state passes them through
as `422`). Ingest names them, and the UI keeps one sentence per code, with
"We couldn’t add that feed. Try again." for any code it doesn't know.

### 1.5 Settings (`/settings`)

Three `Card`s in one column:

- **Account**: "Signed in with Vercel as {email}." · [Sign out].
- **API keys**: "A key lets a feed reader or a script read your entries
  and mark them read. Treat it like a password." Then a `Table` with Name,
  Key (`start` + "…", monospace), Created, Last used ("Never" when
  `lastRequest` is null) and a [Revoke] ghost button. Then
  [+ Create API key].
- **Keyboard shortcuts**: "Single-letter keys like J and K. Turn them off
  if they get in your way." · [Show shortcuts] [Turn off / Turn on].

| State | Sentences | Capture |
| --- | --- | --- |
| keys listed | as above | `desktop-settings.png`, `dark-settings.png`, `phone-settings.png` (Created and Last used are hidden below 640 px) |
| no keys | `Empty`: **No API keys** · "Create one when a reader app or a script needs to reach your feeds." · [+ Create API key] | `desktop-settings-empty.png` |
| create | `Dialog` **Create API key** · "Name it after where you’ll use it, so you know which one to revoke later." · Field "Name" (required, 1–64 characters) · [Cancel] [Create] | `desktop-key-create.png` |
| created, shown once | `Dialog` with no close button: **Copy your new key** · "This is the only time you’ll see it. If you lose it, revoke it and make another." An `InputGroup` holds the key read-only and a copy `InputGroupButton`, with the hint "Send it as the x-api-key header." · [Done]. After copying, the toast says "Key copied". | `desktop-key-created.png` |
| revoke | `AlertDialog` **Revoke “{name}”?** · "Anything using this key stops working at once. This can’t be undone." · [Cancel] [Revoke key]; toast "Key revoked" | `desktop-key-revoke.png` |
| create failed | toast "Couldn’t create the key. Try again." | |

There is no expiry column: the create dialog sets no expiry, so every key
would read "Never" (an answer to state's question 5). Expiring keys can
come later.

### 1.6 Admin (`/admin`)

Kept to what state gives the admin, and nothing more:

- **Users**: a `Table` with Email (a `Badge` "you" on the admin's own row),
  Joined, Feeds and [Delete]. The admin cannot delete their own row. The
  card's line reads "Registration is {open|closed}. Change
  REGISTRATION_ENABLED and redeploy to change it."
- **Feeds**: a `Table` with URL, Subscribers, Failures, Last error and Last
  success, failing feeds first.
- **Delete** opens an `AlertDialog`: **Delete {email}?** · "Their
  subscriptions, read marks and API keys are deleted. Feeds others follow
  stay. This can’t be undone." · [Cancel] [Delete user].

Captures: `dark-admin.png`, `dark-admin-delete.png`.

There is no paging: at this scale a table of a few hundred rows is fine.
If the owner wants no admin screen at all, this section and its build unit
drop out, and nothing else depends on them.

## 2. Keys

There is one client listener (§4) for the whole `(reader)` group. It acts
only when all of these hold:

- the focus is not in an `input`, `textarea`, `select` or contenteditable;
- no dialog, sheet or menu is open (`document.querySelector('[data-slot$="-content"][data-open]')`,
  or a flag from our dialogs);
- no modifier is held but Shift: Ctrl, ⌘ and Alt combinations are never
  ours, so no browser shortcut is ever shadowed;
- the shortcuts are switched on (the default is on; §2.3).

| Key | List | Entry | Same as |
| --- | --- | --- | --- |
| `j` | move the cursor down (scrolling it into view) | open the next entry | ↓ button |
| `k` | move the cursor up | open the previous entry | ↑ button |
| `o`, `Enter` | open the entry under the cursor | — | click the row |
| `u`, `Esc` | — | back to the list it came from | ← button |
| `m` | toggle read/unread on the cursor row | toggle read/unread | Mark as read/unread |
| `v` | open the cursor row's original in a new tab | open the original | Open original |
| `Shift+A` | Mark all as read (opens the confirm; `Enter` confirms) | same, for the list it came from | ✓✓ button |
| `r` | reload the list (`router.refresh()`) | — | — |
| `a` | open Add a feed | open Add a feed | `+` |
| `?` | open the shortcuts dialog | same | menu item |
| `d` | dark/light (from the template) | same | Theme menu |
| `⌘B` / `Ctrl+B` | toggle the sidebar (from the template) | same | `SidebarTrigger` |

The cursor starts on the first row. It is kept in the client and not in
the URL. Back from an entry puts it on that entry's row, if the row is
still there.

### 2.1 Checked against the browser

| Key | Chrome / Edge | Safari | Firefox | Verdict |
| --- | --- | --- | --- | --- |
| plain letters (j k o u m v r a d) | not bound | not bound | not bound, but with "Search for text when you start typing" (off by default) letters start find-in-page | ours; the listener calls `preventDefault()` only on a key it handles |
| `?` (Shift+/) | not bound | not bound | not bound (`/` and `'` are quick find; `?` is not) | ours |
| `Shift+A` | not bound | not bound | not bound | ours |
| `Enter` | activates the focused link/button | same | same | we act on `Enter` only when the focus is on `body` or the list, never on a control |
| `Esc` | stops loading; closes dialogs | same | same | dialogs get it first (Base UI); ours only on the entry page with nothing open |
| `Space` / `Shift+Space` | scroll | scroll | scroll | **not ours**, left to the browser |
| `⌘B` / `Ctrl+B` | not bound (Chrome) | not bound | Ctrl+B / ⌘B opens the bookmarks sidebar, but a page's `preventDefault` wins because it is not a reserved key | kept from the template |
| `/` | — | — | quick find | **not used** (no search in v1) |

Screen readers: NVDA and JAWS in browse mode take single letters for their
own navigation before the page sees them, so our keys do nothing there.
That is harmless. VoiceOver's Quick Nav is off by default.

WCAG 2.1.4 (Character Key Shortcuts, level A) asks that single-key
shortcuts can be turned off or remapped. Hence the switch in §2.3.

### 2.2 How keys are shown

- In the **shortcuts dialog** (`?`, `desktop-shortcuts.png`): a `Dialog`
  with a two-column `Table` of label and `KbdGroup`/`Kbd`, the line "Enter
  also opens the selected entry, and Esc goes back to the list.", and
  [Turn shortcuts off].
- In **tooltips** on the buttons that have a key: "Mark as unread `M`",
  "Next `J`", "Previous `K`", "Open original `V`", "Back to list `U`",
  "Mark all as read `⇧ A`". The `Kbd` is inside `TooltipContent`, which the
  preset styles for exactly that.
- In **menus**, `DropdownMenuShortcut` ("Mark all as read ⇧A", "Keyboard
  shortcuts ?").
- On touch screens there are no hover tooltips, and the dialog is still
  reachable from the menu. Nothing else is shown there.
- `⌘` shows on macOS and "Ctrl" elsewhere (from `navigator.platform` /
  `userAgentData`, on the client).

### 2.3 The switch

The "Turn shortcuts off" setting is kept in `localStorage`
(`rssify:shortcuts = "off"`). It is per browser, needs no database column,
and the first load in a new browser has the keys on.

The template's `d` listener lives in `theme-provider.tsx` and must check
the same value. That is a one-line edit to a generated file, in behaviour
only.

## 3. The sentences

Every sentence is in the tables above, next to its state. The rest are:

- Page titles (`metadata.title`):
  - "{n} unread · rssify" on the lists, and "rssify" at 0;
  - "{entry title} · rssify";
  - "Settings · rssify";
  - "Sign in · rssify";
  - "Admin · rssify".
- Sidebar: "All feeds", "Feeds", "Add feed", and "Not updating — open for
  details" (tooltip).
- Account menu: "Settings", "Keyboard shortcuts", "Admin", "Theme", "Light",
  "Dark", "System", "Sign out".
- Feed menu: "Open website", "Copy feed URL" (toast "Feed URL copied"),
  "Mark all as read", "Unsubscribe…".
- Toasts on a failed action:
  - "Couldn’t mark it as read. Try again."
  - "Couldn’t unsubscribe. Try again."
  - "Couldn’t mark entries as read. Try again."
- Session expired during an action: the redirect to `/sign-in`, with no
  toast.

Style: sentence case, curly apostrophes, no exclamation marks, and "you"
rather than "your account". Buttons are verbs, and the confirming button
repeats the verb in the title ("Unsubscribe", "Revoke key", "Mark as read",
"Delete user").

## 4. Server and client components, server actions, first paint

**Server components** fetch with Prisma through `lib/reader.ts` (state §4)
and render without client JS:

- `app/(reader)/layout.tsx`: the session (`requireUser()`; redirect to
  `/sign-in`), then the subscriptions with unread counts. It passes plain
  data to the client sidebar.
- `app/(reader)/page.tsx`, `feeds/[feedId]/page.tsx`: the entry list for the
  scope, filter and cursor, plus `asOf`.
- `app/(reader)/entries/[entryId]/page.tsx`: the entry, with its content
  rendered from the stored, already-sanitised HTML (ingest's call; state's
  question 4), and the two neighbour ids.
- `app/(reader)/settings/page.tsx`: the API key rows (`auth.api.listApiKeys`
  with the request headers).
- `app/(reader)/admin/page.tsx`: the admin check (`notFound()` for others)
  and both tables.
- `app/sign-in/page.tsx`: reads `?error`.
- `loading.tsx`, `error.tsx` (this one must be a client component, as
  Next.js requires) and `not-found.tsx` for each group.

**Client components**, and why each one is:

| Component | Why client |
| --- | --- |
| `AppSidebar` | shadcn `Sidebar` is client (open state, the mobile `Sheet`, ⌘B); it gets the data as props |
| `EntryList` | holds the keyboard cursor and the `m`/`v`/`o` handlers. It receives rows as plain data (no content), at most 50. |
| `EntryActions` | marks read on mount, `m`/`v`/`u`/`j`/`k`, and the header buttons |
| `Hotkeys` | the one `keydown` listener, the switch, and the `?` dialog |
| `AddFeedDialog` | form state (`useActionState`) and the "pick one" step |
| `MarkAllDialog`, `UnsubscribeDialog`, `RevokeKeyDialog`, `DeleteUserDialog` | `AlertDialog`s with a pending state |
| `CreateKeyDialog` | the create, show-once and copy flow |
| `SignInButton` | `authClient.signIn.social`, and the redirecting state |
| `UserMenu` | `DropdownMenu`, theme, sign out (`authClient.signOut`) |
| `Toaster` | sonner |

**Server actions** live in `app/(reader)/actions.ts`. Each one starts with
`requireUser()` (a session only, never an API key: state §4), calls
`lib/reader.ts`, and ends with `revalidatePath('/', 'layout')` so that the
sidebar counts and the list are fresh:

- `subscribe({ url } | { source })` → `{ ok: true, feedId } | { ok: false, code, choices? }`
- `unsubscribe(feedId)`
- `markRead(entryId)`, `markUnread(entryId)`
- `markAllRead({ feedId?, upTo })`
- `createApiKey(name)` → `{ key }`, through `auth.api.createApiKey` with
  the request headers; `revokeApiKey(keyId)`
- `deleteUser(userId)`: admin only, checked again inside the action.

Under the Unread filter, a row marked read with `m` leaves the list at the
next render, and the cursor stays at the same index, so it lands on the
next row. That is intended: `m` means "done with this one".

**What the reader's first paint costs on a cold start.** No number here is
measured, because nothing is deployed. The parts are:

1. **A Vercel Function cold start** for the RSC request: Node boot, the
   route's bundle, and the Prisma client. Prisma 7's TypeScript client with
   a driver adapter has no query-engine binary to load (state §3), which is
   the largest saving open to us.
2. **Neon** may have scaled to zero. Waking it adds Neon's resume time to
   the first query only.
3. **Three queries**: the session (by cookie), the subscriptions with unread
   counts (one grouped query), and 50 list rows (one keyset query). They
   run in parallel with `Promise.all` once the session is known.
4. **Streaming**:
   - `loading.tsx` streams the shell and skeletons first, so the first
     paint does not wait for 2 and 3.
   - The sidebar and the list are separate `Suspense` boundaries, so a slow
     count query does not hold the list.
5. **Client JS**: React, Base UI (the sidebar, tooltips, and dialogs, which
   load only when opened, through `next/dynamic`), and our small components.
   There is no editor, no markdown renderer and no date library on the
   client.

Things to measure at the first preview deploy (ship team):

- cold and warm TTFB of `/`;
- the size of the client JS for `/`.

To keep the session lookup to one query or none, see state's question
on better-auth's `session.cookieCache`.

## 5. shadcn/ui components used, as they come

Used as they are: `sidebar`, `button`, `badge`, `item`, `empty`, `alert`,
`alert-dialog`, `dialog`, `dropdown-menu`, `field`, `input`, `input-group`,
`label`, `kbd`, `skeleton`, `spinner`, `separator`, `table`, `card`,
`tooltip`, `sonner`, and `sheet` (inside `sidebar`).

These were added with
`shadcn add sidebar badge scroll-area separator skeleton empty alert dialog alert-dialog input field sonner kbd dropdown-menu sheet tooltip table card spinner item input-group label`.
`scroll-area` turned out not to be needed.

The only classes put on top are for layout: widths, gaps, `max-sm:sr-only`,
and `min-w-0` on `SidebarInset`. Without that last one, a long `<pre>` in
an entry pushes the whole column wider than a phone; the first phone
captures showed it. There is no colour, radius or type of our own.

Not covered by shadcn/ui:

1. **Article typography** for entry content (headings, lists, `pre`,
   `blockquote`, images, tables inside a feed's HTML). shadcn has no prose
   component. Owner question 1.
2. **The Vercel logo** on the sign-in button. lucide has none, so the mock
   uses a plain triangle path. The real button should use Vercel's own
   logomark SVG from its brand page, inline, in `currentColor`.
3. **The keyboard listener.** It is about 40 lines of our own (above),
   not a library such as `react-hotkeys-hook`. The template's own `d`
   hotkey is written the same way. Decided, not a question, unless the
   owner prefers the dependency.
4. **Relative time**: `Intl.RelativeTimeFormat`, with no library.

**Reduced motion.** The preset does not quiet its motion under
`prefers-reduced-motion`:

- `Skeleton` is `animate-pulse` (`components/ui/skeleton.tsx`);
- the dialog, sheet and menu enter/exit animations come from
  `tw-animate-css` 1.4.0;
- `shadcn/tailwind.css` handles reduced motion only for its `shimmer`
  utility.

The design adds one block to `app/globals.css` that, under
`prefers-reduced-motion: reduce`, sets animation and transition durations
to near zero. The `Spinner` then stands still beside its text ("Adding…",
"Redirecting to Vercel…"), which still says what is happening. Nothing else
in the UI moves.

## 6. Narrow (phone) layout

- **Below 768 px**, the shadcn breakpoint: the sidebar becomes a `Sheet`,
  opened by the `SidebarTrigger` in the header (`phone-reader-sidebar.png`).
  Choosing a feed closes it (`setOpenMobile(false)` on navigation).
- The **list** is full width with the same rows (`phone-reader.png`). In
  the list header, Unread/All and ✓✓ stay, and the feed `…` menu stays.
- The **entry** is full width. The header buttons are icon-only, with
  labels kept for screen readers (`phone-entry.png`). Back is the ←
  button, or the browser's own Back.
- **Dialogs** are the shadcn `Dialog` as it comes: centred, near full
  width (`phone-add.png`).
- **Settings**: the API key table hides Created and Last used below 640 px
  (`phone-settings.png`).
- **Wide desktop** (`wide-reader.png`, `wide-entry.png`): the list is at
  most `max-w-3xl` and the article at most 65ch, both centred. There is no
  third pane.
- There are no swipe gestures and no pull-to-refresh: the browser's own
  scrolling and Back only.

The preset's controls are small: `Button` is `h-7` (28 px) by default, and
icon buttons are 28 px. That is under the 44 px touch target that Apple's
HIG suggests and above WCAG 2.2's 24 px minimum (2.5.8, level AA). The
design keeps the preset as it is (owner question 3).

## Build units for the UI (in the shared order)

They come after state's units 1–3 (foundation, `lib/reader.ts`, ingest).
Each one is shippable alone.

1. **Sign-in.** `/sign-in` with all four states, `SignInButton`, the
   `(reader)` group layout with `requireUser()`, and the sign-out menu.
   This replaces the "bare sign-in page" placeholder in state's unit 1.
2. **Reader read-only.**
   - The sidebar with counts and failing marks; `/` and `/feeds/[feedId]`
     with the Unread/All filter, cursor paging and every empty, loading,
     error and failing state; `/entries/[entryId]` with mark-on-open,
     prev/next and not-found.
   - The `min-w-0` fix and the reduced-motion block.
   - The typography choice (after owner question 1).
3. **Reader actions.** Mark read/unread, Mark all as read with its
   confirm, Add a feed with its states, and Unsubscribe; toasts.
4. **Keys.** The `Hotkeys` listener, cursor, `?` dialog, tooltips and
   menu shortcuts, the switch, and the `d` check in `theme-provider.tsx`.
5. **Settings.** Account, API keys (list, create, show once, revoke), and
   the shortcuts switch.
6. **Admin.** The `/admin` tables and delete user (state's unit 6). It is
   dropped if the owner says no admin screen.

The tests for these units are state's (§6). The UI part is:

- one test that the keys map to the right actions, on `EntryList`'s pure
  reducer;
- the error-code → sentence map, tested as a table.

## Decisions made

- Routes: `/sign-in`, `/`, `/feeds/[feedId]`, `/entries/[entryId]`,
  `/settings` and `/admin`. Add a feed is a dialog. The list state (filter,
  cursor) lives in the URL; the keyboard cursor lives in the client.
- One main column, showing the list *or* the entry, at every width. There
  is no three-pane layout.
- Paging by an "Older entries" link (server-rendered, 50 per page), not by
  infinite scroll.
- The default filter is Unread. Read rows are muted under All.
- Opening an entry marks it read through a client-called server action,
  never in the render. Entry links don't prefetch.
- Mark all as read always asks first, uses `upTo = asOf`, and has no undo.
- "Unsubscribe", not "Delete", because feeds are shared.
- Keys: `j k o/Enter u/Esc m v Shift+A r a ?`, plus the template's `d` and
  ⌘B. They never use a modifier other than Shift, and can be switched off
  per browser (WCAG 2.1.4).
- Shown in the `?` dialog, in tooltips with `Kbd`, and in menus with
  `DropdownMenuShortcut`.
- The shadcn components from the preset (`base-mira`, Base UI, neutral,
  lucide) are used as they come. Our only additions are layout classes,
  `min-w-0` on `SidebarInset`, and a reduced-motion block.
- Sign-in error mapping: `signup_disabled` → "Registration is closed";
  anything else → "Sign-in didn’t finish".
- API keys have no expiry in v1, so there is no expiry column.
- The failing alert is a plain `Alert` with no red. The UI promises no
  retry schedule.
- The keyboard listener is our own ~40 lines, with no hotkey library.

## Questions for the owner

1. **Article typography.** Feed content is arbitrary HTML, and shadcn/ui
   has nothing that styles it. Options:
   - (a) `@tailwindcss/typography`, a new dev dependency: `prose
     dark:prose-invert`, as in the captures. It adds no client JS.
   - (b) About 30 lines of our own CSS for `article` elements.
   - (c) Leave it unstyled (Tailwind's reset leaves headings and lists
     flat, which reads badly).

   Recommended: (a).
2. **Admin screen.** State gives the admin users and feeds lists plus
   deleting a user (§1.6, two captures). Options: keep it, or have no admin
   screen in v1 (the admin is then only the person who can sign in while
   registration is closed). Recommended: keep it, since it is two tables.
3. **Touch target size.** The preset's buttons are 28 px high, under the
   44 px Apple suggests for touch and above WCAG 2.2's 24 px. Options:
   - (a) keep the preset as it is;
   - (b) bump interactive sizes below 768 px only (a look of our own on
     top).

   Recommended: (a).

## Questions for ingest

1. **Discovery error codes** for `subscribe` (§1.4): the UI has sentences
   for `invalid_url`, `not_found` (no feed at that address), `unreachable`
   (DNS, timeout or 5xx), `blocked` (the SSRF guard) and `multiple`
   (several feeds found, with `choices: [{ title, url }]`). Are these
   your codes, and is "several feeds found" returned to the person to pick
   from, or do you pick the first?
2. **Is adding synchronous?** The UI assumes `subscribe` does discovery
   inline (one fetch, under your timeout), creates the feed, and enqueues
   the first poll. The person then lands on "Nothing here yet" until the
   poll lands. If you poll inline instead, the empty state is rarely seen.
   Either works, but say which, and roughly how long the first poll takes
   after a subscribe.
3. **`lastError` text** is shown to people as it is (§1.2). Keep it one
   short, human sentence fragment without a stack trace or URL, e.g.
   "the site answered 404 Not Found".
4. **Entry content** arrives as sanitised HTML (state's question 4 to you).
   The UI renders it with `dangerouslySetInnerHTML` inside `prose` and does
   no sanitising of its own. Links in it should carry
   `rel="noopener noreferrer"`. Can you add that at ingest?
5. **Built-in sources list**: the dialog needs `{ id, title, siteUrl, note }`
   for each plugin, from the plugin registry. Can the registry export that?

## Questions for state

1. **`signup_disabled` from the hook.** Your hook throws in
   `databaseHooks.user.create.before`. In better-auth 1.7.12 the callback
   redirects with `e.body.code` (`callback.mjs:151`), so the `APIError`
   needs `code: 'signup_disabled'` exactly. Does it? An alternative is the
   provider's own `disableSignUp`, which yields the same code, but it
   cannot exempt the admin.
2. **Neighbours for `j`/`k`** on the entry page: `lib/reader.ts` needs
   `neighbours(userId, entryId, { feedId?, unreadOnly })` →
   `{ prevId, nextId }`, using the same keyset as the list. Under Unread,
   the entry just opened is itself read by then, so the query should
   anchor on its `(sortAt, id)` and not filter it out.
3. **Unread count of a scope**, for the "Mark 37 entries as read?" title:
   the sidebar count is enough for one feed and for All. Confirm that both
   come from the same grouped query.
4. **Session lookup cost**: do you turn on better-auth's
   `session.cookieCache`, so that the reader's first paint skips the
   session query?
5. **API key expiry**: the UI creates keys with no expiry (§1.5). Fine?
6. **List row shape**: the client `EntryList` gets
   `{ id, feedId, feedTitle, title, summary, sortAt, read, url }`. Is
   `feedTitle` cheap to join there, or should the client map it from the
   sidebar data by `feedId`?

## Capture index

All are 1280×800 unless named `wide-` (1680×1000) or `phone-` (390×844).
`dark-` is the dark theme.

- Sign-in: `desktop-signin`, `desktop-signin-redirecting`,
  `desktop-signin-closed`, `desktop-signin-error`, `phone-signin-closed`,
  `dark-signin`.
- Reader:
  - lists: `desktop-reader`, `desktop-reader-allfilter`,
    `desktop-reader-empty`, `desktop-reader-loading`,
    `desktop-reader-caughtup`, `desktop-reader-error`;
  - one feed: `desktop-feed-menu`, `desktop-feed-failing`,
    `desktop-feed-new`, `desktop-feed-remove`, `desktop-markall`;
  - wide, dark and phone: `wide-reader`, `dark-reader`,
    `dark-feed-failing`, `phone-reader`, `phone-reader-sidebar`,
    `phone-feed-failing`, `phone-dark-reader`.
- Entry: `desktop-entry`, `wide-entry`, `dark-entry`, `phone-entry`,
  `dark-entry-gone`.
- Add a feed: `desktop-add`, `desktop-add-adding`, `desktop-add-choose`,
  `desktop-add-error`, `dark-add`, `phone-add`.
- Keys: `desktop-shortcuts`.
- Settings: `desktop-settings`, `desktop-settings-empty`,
  `desktop-key-create`, `desktop-key-created`, `desktop-key-revoke`,
  `dark-settings`, `phone-settings`.
- Admin: `dark-admin`, `dark-admin-delete`.
