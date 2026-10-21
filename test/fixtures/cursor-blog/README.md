# cursor-blog fixtures

Post pages saved once with `curl -sSL -A 'rssify/1.0
(+https://github.com/IKatsuba/rssify)'` on 2026-10-22; raw response
bodies, never edited, never fetched by tests. The list page they belong to
is `../feeds/cursor-blog.html`.

| File | Source URL | Notes |
| --- | --- | --- |
| `projects.html` | https://cursor.com/blog/projects | og:title, description, `.prose--blog` |
| `git-at-any-scale.html` | https://cursor.com/blog/git-at-any-scale | no meta description |
| `self-hosted-machines.html` | https://cursor.com/blog/self-hosted-machines | og:title, description |

None carries `article:published_time`; the date is the first
`time[datetime]`.
