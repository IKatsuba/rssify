import { scrape, parseHTML } from "../../lib/scraper.ts";
import type { FeedEntry, Provider } from "../../lib/types.ts";

const BLOG_URL = "https://claude.com/blog";

interface PostDetails {
  summary?: string;
  content?: string;
}

/**
 * Fetch summary (meta description) and content (rich text body)
 * from an individual blog post page.
 */
export async function fetchPostDetails(url: string): Promise<PostDetails> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Rssify/1.0)" },
    });
    if (!res.ok) return {};
    const html = await res.text();
    const doc = parseHTML(html);
    if (!doc) return {};

    const meta = doc.querySelector('meta[name="description"]');
    const summary = meta?.getAttribute("content")?.trim() || undefined;

    const richText = doc.querySelector(".u-rich-text-blog");
    const content = richText?.innerHTML?.trim() || undefined;

    return { summary, content };
  } catch {
    return {};
  }
}

/**
 * Parse blog posts from claude.com/blog.
 * The page is a Webflow site with static HTML. Each post is a
 * `.blog_cms_item` containing:
 *   - `.card_blog_title` — post title
 *   - `.u-text-style-caption.u-foreground-tertiary` — date (e.g. "Mar 9, 2026")
 *   - `a.clickable_link` — link to full post (/blog/slug)
 *   - `.card-main_tag-wrap .u-text-style-caption` — category tag
 */
export function parseBlogPosts(html: string): FeedEntry[] {
  const doc = parseHTML(html);
  if (!doc) return [];

  const items = doc.querySelectorAll(".blog_cms_item");
  const entries: FeedEntry[] = [];

  for (const item of items) {
    const titleEl = item.querySelector(".card_blog_title");
    const dateEl = item.querySelector(
      ".u-text-style-caption.u-foreground-tertiary",
    );
    const linkEl = item.querySelector("a.clickable_link");
    const tagEl = item.querySelector(
      ".card-main_tag-wrap .u-text-style-caption",
    );

    const title = titleEl?.textContent?.trim();
    const dateText = dateEl?.textContent?.trim();
    const href = linkEl?.getAttribute("href");
    const tag = tagEl?.textContent?.trim();

    if (!title || !href) continue;

    const link = href.startsWith("http")
      ? href
      : `https://claude.com${href}`;

    const published = dateText ? new Date(dateText) : new Date();

    entries.push({
      id: link,
      title,
      link,
      published: isNaN(published.getTime()) ? new Date() : published,
      summary: undefined,
      categories: tag ? [tag] : [],
    });
  }

  return entries;
}

const provider: Provider = {
  namespace: "blogs",
  route: "claude-code",
  meta: {
    title: "Claude Blog",
    description: "Practical guidance for building with Claude",
    link: BLOG_URL,
    id: "rssify:blogs:claude-code",
    author: "Anthropic",
  },
  async fetch(): Promise<FeedEntry[]> {
    const html = await scrape(BLOG_URL);
    const entries = parseBlogPosts(html);

    // Fetch summary + content from individual post pages in parallel
    const details = await Promise.allSettled(
      entries.map((e) => fetchPostDetails(e.link)),
    );
    for (let i = 0; i < entries.length; i++) {
      const result = details[i];
      if (result.status === "fulfilled") {
        if (result.value.summary) entries[i].summary = result.value.summary;
        if (result.value.content) entries[i].content = result.value.content;
      }
    }

    return entries;
  },
};

export default provider;
