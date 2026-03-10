import { assertEquals, assertStringIncludes } from '@std/assert';
import { buildAtomFeed } from './feed.ts';
import type { FeedEntry, FeedMeta } from './types.ts';

const META: FeedMeta = {
  title: 'Test Feed',
  description: 'A test feed',
  link: 'https://example.com',
  id: 'https://example.com/feed',
  author: 'Test Author',
};

function makeEntry(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id: 'entry-1',
    title: 'Entry Title',
    link: 'https://example.com/entry-1',
    published: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

Deno.test('buildAtomFeed generates valid Atom XML with entries', () => {
  const entries = [
    makeEntry(),
    makeEntry({
      id: 'entry-2',
      title: 'Second Entry',
      link: 'https://example.com/entry-2',
    }),
  ];

  const xml = buildAtomFeed(META, entries);

  assertStringIncludes(xml, '<feed');
  assertStringIncludes(xml, '<entry>');
  assertStringIncludes(xml, '<title>Test Feed</title>');
  assertStringIncludes(xml, '<title>Entry Title</title>');
  assertStringIncludes(xml, '<title>Second Entry</title>');
});

Deno.test('buildAtomFeed generates valid empty feed with 0 entries', () => {
  const xml = buildAtomFeed(META, []);

  assertStringIncludes(xml, '<feed');
  assertStringIncludes(xml, '<title>Test Feed</title>');
  assertEquals(xml.includes('<entry>'), false);
});

Deno.test('buildAtomFeed escapes HTML in summary', () => {
  const entry = makeEntry({ summary: '<script>alert("xss")</script>' });

  const xml = buildAtomFeed(META, [entry]);

  assertStringIncludes(xml, '<entry>');
  // The summary value should be escaped, not contain raw HTML tags
  assertEquals(xml.includes('<script>alert("xss")</script>'), false);
});

Deno.test('buildAtomFeed includes content when provided', () => {
  const entry = makeEntry({ content: '<p>Full article body</p>' });

  const xml = buildAtomFeed(META, [entry]);

  assertStringIncludes(xml, '<entry>');
  assertStringIncludes(xml, 'Full article body');
});
