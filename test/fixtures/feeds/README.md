# Feed fixtures

Saved once with `curl -L --compressed -A 'rssify/1.0
(+https://github.com/IKatsuba/rssify)'` on 2026-10-22; raw response
bodies, never edited, never fetched by tests.

| File | Source URL | Notes |
| --- | --- | --- |
| `claude-dev.rss.xml` | https://claude.dev/rss.xml | RSS 2.0, description only |
| `cursor-changelog.rss.xml` | https://cursor.com/changelog/rss.xml | RSS 2.0, `content:encoded` |
| `hacker-news.rss.xml` | https://news.ycombinator.com/rss | no guid |
| `slashdot.rdf.xml` | https://rss.slashdot.org/Slashdot/slashdotMain | RDF, ISO-8859-1 |
| `opennet.rss.xml` | https://www.opennet.ru/opennews/opennews_all.rss | koi8-r |
| `nextjs-releases.atom.xml` | https://github.com/vercel/next.js/releases.atom | Atom, HTML content, `updated` only |
| `xkcd.atom.xml` | https://xkcd.com/atom.xml | small Atom, `updated` only |
| `jsonfeed-org.feed.json` | https://www.jsonfeed.org/feed.json | JSON Feed 1.0; `jsonfeed.org/feed.json` answers 404, this is the URL jsonfeed.org links |
| `daringfireball.feed.json` | https://daringfireball.net/feeds/json | JSON Feed 1.1 |
| `cursor-blog.html` | https://cursor.com/blog | HTML, not a feed |

Hand-made files start with `handmade-`:

- `handmade-truncated.rss.xml`: the first half of the bytes of
  `claude-dev.rss.xml`.
- `handmade-truncated.atom.xml`: the first half of the bytes of
  `nextjs-releases.atom.xml`.
- `handmade-hostile.atom.xml`: `xml:base`, relative links and hostile HTML
  (script, `onerror`, `javascript:` link, `style`, `srcset`, iframe).
- `handmade-edge-cases.rss.xml`: no link and no guid, a `javascript:` link,
  a blank guid, bad dates, empty titles.
- `handmade-content-text.feed.json`: `content_text` with `<tag>`, a numeric
  id, a bad date, `date_modified` only, an item with neither id nor url.
