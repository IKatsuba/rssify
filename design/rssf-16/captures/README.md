# RSSF-16 U2 captures: /admin and the Admin menu item

Taken at commit 438c0bc (U2 7077ab2 plus the phone fix) on the local stack,
headless Chrome via Playwright, desktop 1280×800 and phone 390×844 at 2×.
The round "N" at the bottom left is Next's dev indicator, not the app.

## Reaching each state

1. `docker compose up -d`, then start the dev server with the admin set
   only for this run: `ADMIN_EMAIL=reader@example.com bun run dev`
   (`.env.local` has no `ADMIN_EMAIL`).
2. `bun --env-file=.env.local scripts/dev-session.ts` prints the admin's
   cookie (reader@example.com); set it on localhost:3210.
3. `bun --env-file=.env.local scripts/dev-seed.ts` adds the mock feeds,
   including one failing and one gone feed.
4. `bun --env-file=.env.local scripts/dev-session.ts other@example.com`
   (and `third@example.com`) adds non-admin users; their cookies show the
   non-admin views.
5. Theme: localStorage `theme` set to `light` or `dark` before load.

| Capture | State | How |
| --- | --- | --- |
| `desktop-light-admin.png`, `desktop-dark-admin.png` | Admin page, full | admin at `/admin` |
| `phone-light-admin.png`, `phone-dark-admin.png` | Admin page on a phone: Users shows Email · Delete; Feeds shows URL · Status · Last error, URLs wrap | same, 390 px |
| `desktop-dark-admin-delete.png`, `phone-light-admin-delete.png`, `phone-dark-admin-delete.png` | Delete dialog | Delete on the first other user's row |
| `desktop-dark-admin-deleted.png` | After Delete user: row gone, toast "User deleted" | Delete on third@example.com, then Delete user |
| `desktop-light-menu-admin.png` | Account menu with Admin (between Keyboard shortcuts and Theme) | admin, email menu at `/` |
| `desktop-light-menu-no-admin.png` | Account menu without Admin | other@example.com, email menu |
| `desktop-light-non-admin-404.png` | Non-admin at `/admin`: not-found page | other@example.com at `/admin` |

Not captured: the failure toast "Couldn’t delete the user. Try again."
(needs a forced server failure) and the loading state.
