import sanitizeHtml from "sanitize-html"

const MAX_CONTENT_BYTES = 200 * 1024
const LINK_REL = "noopener noreferrer nofollow"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// `href`/`src` resolved against `base`, or null when they do not parse.
function absolute(value: string, base: string): string | null {
  try {
    return new URL(value.trim(), base).href
  } catch {
    return null
  }
}

function contentOptions(baseUrl: string): sanitizeHtml.IOptions {
  return {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "img",
      "figure",
      "figcaption",
      "picture",
      "source",
      "video",
      "audio",
    ],
    selfClosing: [...sanitizeHtml.defaults.selfClosing, "source"],
    allowedAttributes: {
      "*": ["href", "src", "alt", "title", "width", "height"],
      a: ["href", "title", "rel", "target"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: {},
    // Runs before the attribute and scheme filters, so a resolved
    // `javascript:` or `data:` URL is still dropped by them.
    transformTags: {
      "*": (tagName, attribs) => {
        for (const name of ["href", "src"]) {
          if (attribs[name] === undefined) continue
          const url = absolute(attribs[name], baseUrl)
          if (url === null) delete attribs[name]
          else attribs[name] = url
        }
        if (tagName === "a") {
          attribs.rel = LINK_REL
          attribs.target = "_blank"
        }
        return { tagName, attribs }
      },
    },
  }
}

function byteLength(text: string): number {
  return encoder.encode(text).length
}

// Cuts to at most `max` UTF-8 bytes without splitting a code point.
function cutBytes(text: string, max: number): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= max) return text
  let end = max
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return decoder.decode(bytes.subarray(0, end))
}

export function sanitizeContent(html: string, baseUrl: string): string | null {
  const options = contentOptions(baseUrl)
  const full = sanitizeHtml(html, options)
  let out = full
  // Re-sanitising a cut closes its open tags, which can add bytes back, so
  // shrink the cut by that overflow until the result fits.
  let budget = MAX_CONTENT_BYTES
  while (byteLength(out) > MAX_CONTENT_BYTES) {
    out = sanitizeHtml(cutBytes(full, budget), options)
    budget -= byteLength(out) - MAX_CONTENT_BYTES
  }
  return out.trim() === "" ? null : out
}

// Block ends and breaks become a space, so "<p>a</p><p>b</p>" reads "a b".
const BLOCK_END =
  /<(?:br|\/(?:p|div|li|h[1-6]|blockquote|tr|td|th|pre))\b[^>]*>/gi

export function plainText(html: string, max: number): string {
  const escaped = sanitizeHtml(html.replace(BLOCK_END, "$& "), {
    allowedTags: [],
    allowedAttributes: {},
  })
  // sanitize-html escapes only these in text; undo exactly that.
  const text = escaped
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
  return Array.from(text).slice(0, max).join("").trim()
}

export function safeUrl(
  value: string | null | undefined,
  base: string
): string | null {
  if (!value) return null
  const url = absolute(value, base)
  if (url === null) return null
  const { protocol } = new URL(url)
  return protocol === "http:" || protocol === "https:" ? url : null
}
