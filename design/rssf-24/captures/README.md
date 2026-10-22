# RSSF-24 U2 captures: Add a feed with four built-in sources

Taken at commit e9f4732 (U2 82746ac plus the edge fix) on the local stack,
using headless Chrome via Playwright at 2×. The round "N" at the bottom left
is Next's dev indicator, not part of the app. Replaces v1's
`design/rssf-11/captures/unit-4/{desktop,phone,dark}-add.png` (design/rssf-22
§2.4, unit 2).

Steps: `docker compose up -d`, then `scripts/dev-session.ts` and
`scripts/dev-seed.ts` (reader@example.com), then the dev server. Open `/`,
press `a`, and set the theme through localStorage `theme`.

| Capture | State |
| --- | --- |
| `desktop-add.png` | 1280×800, light: four sources ordered by title, list flush with the field; it fits, so nothing scrolls |
| `dark-add.png` | 1280×800, dark: same |
| `phone-add.png` | 390×844, light: the list (331 px) fits under 50vh (422 px), so it doesn't scroll at this height |
| `phone-add-scrolled.png` | 375×600, light: the list is capped at 300 px and scrolled to the end; the URL field and separator stay fixed above it |

Known and left alone: in dark mode the separator label sits on a lighter box.
It is already in v1's captures and is not from this unit.
