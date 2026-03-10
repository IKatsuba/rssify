import { assertEquals } from '@std/assert';
import { parseBlogPosts } from './cursor.ts';

const FIXTURE_HTML = `
<!DOCTYPE html>
<html>
<body>
<div>
  <article class="flex grow-1 flex-col mb-g1">
    <a class="card card--text grow-1 grid-cursor-v1" href="/blog/automations">
      <div class="flex flex-col">
        <div class="grow-1">
          <p class="type-base text-theme-text text-pretty">Build agents that run automatically</p>
          <p class="type-base text-theme-text-sec text-pretty">Cursor now supports automations that run based on triggers.</p>
        </div>
        <div class="mt-v1 text-theme-text-sec flex shrink-0 items-center">
          <span class="capitalize">product · </span>
          <time dateTime="2026-03-05T12:00:00.000Z" class="type-base">Mar 5, 2026</time>
        </div>
      </div>
    </a>
  </article>
  <article class="flex grow-1 flex-col mb-g1">
    <a class="card card--text grow-1 grid-cursor-v1" href="/blog/jetbrains-acp">
      <div class="flex flex-col">
        <div class="grow-1">
          <p class="type-base text-theme-text text-pretty">Cursor is now available in JetBrains IDEs</p>
          <p class="type-base text-theme-text-sec text-pretty">Use Cursor agents in IntelliJ IDEA, PyCharm, WebStorm.</p>
        </div>
        <div class="mt-v1 text-theme-text-sec flex shrink-0 items-center">
          <span class="capitalize">product · </span>
          <time dateTime="2026-03-04T12:00:00.000Z" class="type-base">Mar 4, 2026</time>
        </div>
      </div>
    </a>
  </article>
</div>
</body>
</html>
`;

Deno.test('parseBlogPosts extracts posts from fixture HTML', () => {
  const posts = parseBlogPosts(FIXTURE_HTML);
  assertEquals(posts.length, 2);
  assertEquals(posts[0].title, 'Build agents that run automatically');
  assertEquals(posts[1].title, 'Cursor is now available in JetBrains IDEs');
});

Deno.test('parseBlogPosts returns empty array for HTML without posts', () => {
  const html = `<html><body><p>No posts here</p></body></html>`;
  const posts = parseBlogPosts(html);
  assertEquals(posts.length, 0);
});

Deno.test('parseBlogPosts builds full URLs from relative hrefs', () => {
  const posts = parseBlogPosts(FIXTURE_HTML);
  assertEquals(posts[0].link, 'https://cursor.com/blog/automations');
  assertEquals(posts[1].link, 'https://cursor.com/blog/jetbrains-acp');
});

Deno.test('parseBlogPosts parses dates from dateTime attribute', () => {
  const posts = parseBlogPosts(FIXTURE_HTML);
  const date = posts[0].published;
  assertEquals(isNaN(date.getTime()), false);
  assertEquals(date.getFullYear(), 2026);
  assertEquals(date.getMonth(), 2); // March = 2
  assertEquals(date.getDate(), 5);
});

Deno.test('parseBlogPosts uses post URL as id', () => {
  const posts = parseBlogPosts(FIXTURE_HTML);
  assertEquals(posts[0].id, 'https://cursor.com/blog/automations');
});

Deno.test('parseBlogPosts extracts category', () => {
  const posts = parseBlogPosts(FIXTURE_HTML);
  assertEquals(posts[0].categories, ['product']);
});

Deno.test('parseBlogPosts extracts excerpt as summary', () => {
  const posts = parseBlogPosts(FIXTURE_HTML);
  assertEquals(
    posts[0].summary,
    'Cursor now supports automations that run based on triggers.',
  );
});
