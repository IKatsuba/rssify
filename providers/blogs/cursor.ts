import { getCached, setCache } from '../../lib/cache.ts';
import { parseHTML, scrape } from '../../lib/scraper.ts';
import type { FeedEntry, Provider } from '../../lib/types.ts';
import TurndownService from 'turndown';

const ITEM_CACHE_TTL = 60 * 60 * 24 * 7;

const BLOG_URL = 'https://cursor.com/blog';

interface PostDetails {
  summary?: string;
  content?: string;
}

/**
 * Fetch summary (meta description) and content (prose body)
 * from an individual Cursor blog post page.
 */
export async function fetchPostDetails(url: string): Promise<PostDetails> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Rssify/1.0)' },
    });
    if (!res.ok) return {};
    const html = await res.text();
    const doc = parseHTML(html);
    if (!doc) return {};

    const meta = doc.querySelector('meta[name="description"]');
    const summary = meta?.getAttribute('content')?.trim() || undefined;

    const prose = doc.querySelector('.prose--blog');
    const contentHtml = prose?.innerHTML?.trim();
    let content: string | undefined;
    if (contentHtml) {
      const td = new TurndownService({ headingStyle: 'atx' });
      content = td.turndown(contentHtml);
    }

    return { summary, content };
  } catch {
    return {};
  }
}

/**
 * Parse blog posts from cursor.com/blog.
 * Each post is an `<article>` containing:
 *   - `a.card` — link wrapping the post (/blog/slug)
 *   - First `p.type-base.text-theme-text` — post title
 *   - Second `p.type-base.text-theme-text-sec` — excerpt
 *   - `time[dateTime]` — publication date
 *   - `span.capitalize` — category (e.g. "product")
 */
export function parseBlogPosts(html: string): FeedEntry[] {
  const doc = parseHTML(html);
  if (!doc) return [];

  const articles = doc.querySelectorAll('article');
  const entries: FeedEntry[] = [];

  for (const article of articles) {
    const linkEl = article.querySelector('a.card');
    const href = linkEl?.getAttribute('href');
    if (!href) continue;

    const paragraphs = article.querySelectorAll('p.type-base');
    const title = paragraphs[0]?.textContent?.trim();
    if (!title) continue;

    const excerpt = paragraphs[1]?.textContent?.trim();

    const timeEl = article.querySelector('time[dateTime]');
    const dateStr = timeEl?.getAttribute('dateTime');
    const published = dateStr ? new Date(dateStr) : new Date();

    const categoryEl = article.querySelector('span.capitalize');
    const categoryText = categoryEl?.textContent?.trim()
      ?.replace(/\s*·\s*$/, '')
      ?.trim();

    const link = href.startsWith('http') ? href : `https://cursor.com${href}`;

    entries.push({
      id: link,
      title,
      link,
      published: isNaN(published.getTime()) ? new Date() : published,
      summary: excerpt,
      categories: categoryText ? [categoryText] : [],
    });
  }

  return entries;
}

const provider: Provider = {
  namespace: 'blogs',
  route: 'cursor',
  meta: {
    title: 'Cursor Blog',
    description: 'News and updates from Cursor',
    link: BLOG_URL,
    id: 'rssify:blogs:cursor',
    author: 'Cursor',
  },
  async fetch(): Promise<FeedEntry[]> {
    const html = await scrape(BLOG_URL);
    const entries = parseBlogPosts(html);

    const details = await Promise.allSettled(
      entries.map(async (e) => {
        const itemKey = `item:${e.link}`;
        const cached = await getCached(itemKey);
        if (cached) {
          return JSON.parse(cached) as PostDetails;
        }
        const result = await fetchPostDetails(e.link);
        if (result.summary || result.content) {
          setCache(itemKey, JSON.stringify(result), ITEM_CACHE_TTL);
        }
        return result;
      }),
    );
    for (let i = 0; i < entries.length; i++) {
      const result = details[i];
      if (result.status === 'fulfilled') {
        if (result.value.summary) entries[i].summary = result.value.summary;
        if (result.value.content) entries[i].content = result.value.content;
      }
    }

    return entries;
  },
};

export { provider };
