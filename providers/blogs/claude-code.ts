import { scrape } from "../../lib/scraper.ts";
import type { FeedEntry, Provider } from "../../lib/types.ts";

const BLOG_URL = "https://www.anthropic.com/research";

interface AnthropicTag {
  _key: string;
  _type: string;
  label: string;
  value: string;
}

interface AnthropicPost {
  _type: string;
  title: string;
  slug: { _type: string; current: string };
  publishedOn: string;
  summary: string | null;
  subjects: AnthropicTag[];
}

/**
 * Extract posts from Next.js RSC streaming data embedded in page HTML.
 * Posts are serialized as JSON inside `self.__next_f.push([...])` script blocks.
 */
export function parseEmbeddedPosts(html: string): AnthropicPost[] {
  const posts: AnthropicPost[] = [];

  // Match all self.__next_f.push() payloads
  const pushPattern = /self\.__next_f\.push\(\[[\d,]*"(.+?)"\]\)/gs;
  let match;

  // Collect all RSC payload chunks
  const chunks: string[] = [];
  while ((match = pushPattern.exec(html)) !== null) {
    // Unescape the string content
    const chunk = match[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\\\/g, "\\");
    chunks.push(chunk);
  }

  const fullPayload = chunks.join("");

  // Find post objects by looking for the pattern with _type: "post"
  const postPattern =
    /\{"_type"\s*:\s*"post"\s*,\s*"title"\s*:\s*"[^"]*".*?"slug"\s*:\s*\{[^}]+\}.*?"publishedOn"\s*:\s*"[^"]*"/g;

  let postMatch;
  while ((postMatch = postPattern.exec(fullPayload)) !== null) {
    // Try to extract a complete JSON object starting from this position
    const startIdx = postMatch.index;
    const obj = extractJsonObject(fullPayload, startIdx);
    if (obj) {
      try {
        const parsed = JSON.parse(obj);
        if (parsed._type === "post" && parsed.title && parsed.slug?.current) {
          posts.push(parsed);
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  return posts;
}

function extractJsonObject(str: string, startIdx: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return str.slice(startIdx, i + 1);
      }
    }
  }

  return null;
}

const provider: Provider = {
  namespace: "blogs",
  route: "claude-code",
  meta: {
    title: "Anthropic Research Blog",
    description: "Latest research and updates from Anthropic",
    link: BLOG_URL,
    id: "rssify:blogs:claude-code",
    author: "Anthropic",
  },
  async fetch(): Promise<FeedEntry[]> {
    const html = await scrape(BLOG_URL);
    const posts = parseEmbeddedPosts(html);

    return posts.map((post) => ({
      id: `https://www.anthropic.com/research/${post.slug.current}`,
      title: post.title,
      link: `https://www.anthropic.com/research/${post.slug.current}`,
      published: new Date(post.publishedOn),
      summary: post.summary ?? undefined,
      categories: post.subjects?.map((s) => s.label) ?? [],
    }));
  },
};

export default provider;
