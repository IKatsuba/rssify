import { describe, expect, test } from "bun:test"

import { plainText, safeUrl, sanitizeContent } from "./sanitize"

const BASE = "https://example.test/news/feed.xml"
const CAP = 200 * 1024
const clean = (html: string) => sanitizeContent(html, BASE)
const bytes = (text: string) => new TextEncoder().encode(text).length

describe("sanitiser adversarial coverage", () => {
  test.each([
    "&#106;avascript:alert(1)",
    "javascript&#58;alert(1)",
    "JAVASCRIPT:alert(1)",
    "java&#x09;script:alert(1)",
    "java&#x0a;script:alert(1)",
    " &#13; javascript:alert(1)",
    "DATA:text/html,evil",
    "vbscript:msgbox(1)",
  ])("drops encoded and disguised unsafe URL %s", (url) => {
    const out = clean(`<a href="${url}">link</a><img src="${url}">`)!
    expect(out).not.toMatch(/\s(?:href|src)=/i)
    expect(out).toContain('rel="noopener noreferrer nofollow" target="_blank"')
  })

  test.each([
    "<svg><g/onload=alert(1)//<p>text</p></svg>",
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<svg><p><style><g title="</style><img src=x onerror=alert(1)>">',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">text',
    "<form><math><mtext></form><form><mglyph><style></math><img src=x onerror=alert(1)>",
  ])("removes active markup from malformed namespace payload %#", (html) => {
    const out = clean(html) ?? ""
    expect(out).not.toMatch(
      /<(?:svg|math|script|style|iframe|form|noscript)\b/i
    )
    // Payload text inside quoted titles is inert; inspect attribute names.
    expect(out.replace(/"[^"]*"/g, '""')).not.toMatch(/\son\w+\s*=/i)
    expect(clean(out)).toBe(out || null)
  })

  test("drops source/picture srcset and extra fetch or active attributes", () => {
    const out = clean(
      '<picture srcset="javascript:alert(1)"><source src="../a.webp" srcset="evil 2x" onerror="evil()">' +
        '<img src="//cdn.example.test/a.png" srcset="evil 2x" style="background:url(evil)" loading="eager" onload="evil()"></picture>' +
        '<video src="movie.mp4" poster="evil" autoplay><source src="movie.webm" srcset="evil"></video>'
    )!
    expect(out).not.toMatch(
      /\s(?:srcset|style|on\w+|poster|autoplay|loading)=/i
    )
    expect(out).toContain('src="https://example.test/a.webp"')
    expect(out).toContain('src="https://cdn.example.test/a.png"')
    expect(out).toContain('src="https://example.test/news/movie.webm"')
  })

  test("keeps safe encoded query strings and forces every anchor's attributes", () => {
    const out = clean(
      '<a href="?a=1&amp;b=2" REL="opener" TARGET="evil">one</a><a>two</a>'
    )!
    expect(out).toContain(
      'href="https://example.test/news/feed.xml?a=1&amp;b=2"'
    )
    expect(
      out.match(/rel="noopener noreferrer nofollow" target="_blank"/g)
    ).toHaveLength(2)
  })

  test.each([-1, 0, 1])(
    "enforces the byte cap at boundary offset %i",
    (offset) => {
      const html = `<p>${"a".repeat(CAP - 7 + offset)}</p>`
      const out = clean(html)!
      expect(bytes(out)).toBeLessThanOrEqual(CAP)
      expect(out.endsWith("</p>")).toBe(true)
      if (offset <= 0) expect(out).toBe(html)
      expect(clean(out)).toBe(out)
    }
  )

  test("caps expansion from escaping and tag closure without broken Unicode", () => {
    const out = clean(
      `<blockquote><p>${"😀<&".repeat(40_000)}</p></blockquote>`
    )!
    expect(bytes(out)).toBeLessThanOrEqual(CAP)
    expect(out).not.toContain("�")
    expect(out.endsWith("</p></blockquote>")).toBe(true)
    expect(clean(out)).toBe(out)
  })

  test("plain text decodes entities once and counts Unicode code points", () => {
    expect(plainText("&#x1f600;&nbsp;&quot;&#39;&amp;lt;b&amp;gt;", 300)).toBe(
      "😀 \"'&lt;b&gt;"
    )
    expect(plainText("😀".repeat(301), 300)).toBe("😀".repeat(300))
    expect(plainText("abc", 0)).toBe("")
    expect(plainText("<script>evil</script><style>evil</style>", 300)).toBe("")
  })

  test("outward URLs reject controls disguising forbidden schemes", () => {
    for (const value of [
      " JaVa\nScRiPt:evil()",
      "DATA:text/html,x",
      "mailto:a@example.test",
      "ftp://example.test/a",
      "http://[",
    ]) {
      expect(safeUrl(value, BASE)).toBeNull()
    }
    expect(safeUrl("HTTPS://EXAMPLE.TEST:443/a", BASE)).toBe(
      "https://example.test/a"
    )
    expect(safeUrl("#section", BASE)).toBe(`${BASE}#section`)
  })
})
