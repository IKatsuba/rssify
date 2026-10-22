# firefox-releases fixtures

Saved once with `curl -sSL -A 'rssify/1.0
(+https://github.com/IKatsuba/rssify)'` on 2026-10-22; raw response
bodies, never edited, never fetched by tests. No response set a cookie.

| File            | Source URL                                                  | Notes                                                                                                                                      |
| --------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `releases.html` | https://www.firefox.com/en-US/releases/                     | 806 `/firefox/{v}/releasenotes/` links, unlocalised and newest first, some repeated; ESR (`153.0esr`, `153.1.0`, …) sits beside the majors |
| `158.0.html`    | https://www.firefox.com/en-US/firefox/158.0/releasenotes/   | major release; `.c-release-date` "October 13, 2026"; notes open with Smart Window form fill, end with the contributors list                |
| `158.0.1.html`  | https://www.firefox.com/en-US/firefox/158.0.1/releasenotes/ | dot release; "October 20, 2026"; notes open with the eMudhra OneCRL fix, end with "Various security fixes."                                |

The list's unlocalised links answer 302 to their `/en-US/` page.
