import { describe, expect, test } from "bun:test"

import { plainText, safeUrl, sanitizeContent } from "./sanitize"

const BASE = "https://example.com/blog/post-1"
const clean = (html: string) => sanitizeContent(html, BASE)
const bytes = (text: string) => new TextEncoder().encode(text).length

describe("sanitizeContent", () => {
  test("strips script, on* handlers, style and iframe", () => {
    const out = clean(
      '<p style="color:red" onclick="x()">hi</p><script>alert(1)</script>' +
        '<img src="/a.png" onerror="alert(1)"><iframe src="https://evil.test"></iframe>' +
        "<style>p{}</style>"
    )
    expect(out).toBe('<p>hi</p><img src="https://example.com/a.png" />')
  })

  test("drops javascript: and data: URLs, keeps mailto", () => {
    expect(clean('<a href="javascript:alert(1)">x</a>')).toBe(
      '<a rel="noopener noreferrer nofollow" target="_blank">x</a>'
    )
    expect(clean('<a href=" JaVa\tScript:alert(1)">x</a>')).not.toContain(
      "href"
    )
    expect(clean('<img src="data:image/png;base64,AAAA">')).toBe("<img />")
    expect(clean('<a href="mailto:me@example.com">m</a>')).toBe(
      '<a href="mailto:me@example.com" rel="noopener noreferrer nofollow" target="_blank">m</a>'
    )
  })

  test("drops srcset and keeps media tags", () => {
    const out = clean(
      '<picture><source srcset="a.webp 1x" src="a.webp"><img src="a.png" srcset="a2.png 2x" alt="A" width="10" height="5"></picture>' +
        '<figure><video src="v.mp4"></video><audio src="//cdn.example.net/a.mp3"></audio><figcaption>c</figcaption></figure>'
    )
    expect(out).toBe(
      '<picture><source src="https://example.com/blog/a.webp" /><img src="https://example.com/blog/a.png" alt="A" width="10" height="5" /></picture>' +
        '<figure><video src="https://example.com/blog/v.mp4"></video><audio src="https://cdn.example.net/a.mp3"></audio><figcaption>c</figcaption></figure>'
    )
  })

  test("absolutises links and overrides rel and target", () => {
    expect(
      clean('<a href="../about" rel="opener" target="_self" title="t">a</a>')
    ).toBe(
      '<a href="https://example.com/about" rel="noopener noreferrer nofollow" target="_blank" title="t">a</a>'
    )
    expect(clean('<a href="//other.example.org/x">b</a>')).toContain(
      'href="https://other.example.org/x"'
    )
  })

  test("returns null when nothing is left", () => {
    expect(clean("")).toBeNull()
    expect(clean("<script>x</script>  ")).toBeNull()
  })

  test("caps at 200 KB on a code-point boundary with tags closed", () => {
    const max = 200 * 1024
    const big = "<p><b>" + "é😀".repeat(60_000) + "</b></p>"
    const out = clean(big)!
    expect(bytes(out)).toBeLessThanOrEqual(max)
    expect(bytes(out)).toBeGreaterThan(max - 64)
    expect(out).not.toContain("�")
    expect(out.endsWith("</b></p>")).toBe(true)
  })

  test("leaves content under the cap untouched", () => {
    const html = "<p>" + "a".repeat(1000) + "</p>"
    expect(clean(html)).toBe(html)
  })
})

describe("plainText", () => {
  test("drops tags and script text, decodes entities, collapses space", () => {
    expect(
      plainText(
        "<p>Tom &amp; Jerry&nbsp;&lt;3</p>\n\n<script>evil()</script><p>Second &amp;lt; line</p>",
        300
      )
    ).toBe("Tom & Jerry <3 Second &lt; line")
  })

  test("cuts to max code points and trims", () => {
    expect(plainText("😀😀😀 abc", 4)).toBe("😀😀😀")
    expect(plainText("  ", 10)).toBe("")
  })
})

describe("safeUrl", () => {
  test("resolves relative and protocol-relative against the base", () => {
    expect(safeUrl("/x?y=1", BASE)).toBe("https://example.com/x?y=1")
    expect(safeUrl("//cdn.example.net/a", BASE)).toBe(
      "https://cdn.example.net/a"
    )
    expect(safeUrl(" http://example.org ", BASE)).toBe("http://example.org/")
  })

  test("refuses other schemes and empty values", () => {
    expect(safeUrl("javascript:alert(1)", BASE)).toBeNull()
    expect(safeUrl("mailto:me@example.com", BASE)).toBeNull()
    expect(safeUrl("data:text/html,x", BASE)).toBeNull()
    expect(safeUrl("", BASE)).toBeNull()
    expect(safeUrl(null, BASE)).toBeNull()
    expect(safeUrl("x", "not a url")).toBeNull()
  })
})
