# anthropic-news fixtures

Saved once with `curl -sSL -A 'rssify/1.0
(+https://github.com/IKatsuba/rssify)'` on 2026-10-22; raw response
bodies, never edited, never fetched by tests. No response set a cookie.

| File | Source URL | Notes |
| --- | --- | --- |
| `list.html` | https://www.anthropic.com/news | featured tiles (`…__tileLink`) and table rows (`…__title-link`), topic links to `/news/announcements` etc., `time` text only |
| `cyber-verification-program.html` | https://www.anthropic.com/news/cyber-verification-program | a `/news/` post, `article:published_time` 2026-10-06 |
| `claude-opus-5-5.html` | https://www.anthropic.com/claude-opus-5-5 | a root launch page, no `article:published_time`, body under `p.post-text` |
| `ebola-response.html` | https://www.anthropic.com/features/ebola-response | a `/features/…` page, no `article:published_time`, no `p.post-text` |
