import { scrape, parseHTML } from "../../lib/scraper.ts";
import type { FeedEntry, Provider } from "../../lib/types.ts";

const BLOG_URL = "https://claude.com/blog";

/**
 * Parse blog posts from claude.com/blog.
 * The page is a Webflow site with static HTML. Each post is a
 * `.blog_cms_item` containing:
 *   - `.card_blog_title` — post title
 *   - `.u-text-style-caption.u-foreground-tertiary` — date (e.g. "Mar 9, 2026")
 *   - `a.clickable_link` — link to full post (/blog/slug)
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

    const title = titleEl?.textContent?.trim();
    const dateText = dateEl?.textContent?.trim();
    const href = linkEl?.getAttribute("href");

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
      categories: [],
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
    return parseBlogPosts(html);
  },
};

export default provider;
