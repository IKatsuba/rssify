import { assertEquals } from "@std/assert";
import { parseBlogPosts } from "./claude-code.ts";

const FIXTURE_HTML = `
<!DOCTYPE html>
<html>
<body>
<div role="listitem" class="blog_cms_item w-dyn-item">
  <div class="card_blog_wrap">
    <div class="card_blog_content">
      <div>
        <div class="u-text-style-caption u-foreground-tertiary u-mb-1-5">Mar 9, 2026</div>
        <div class="card_blog_title u-text-style-h6">Bringing Code Review to Claude Code</div>
      </div>
    </div>
    <a href="/blog/code-review" class="clickable_link w-inline-block"></a>
  </div>
</div>
<div role="listitem" class="blog_cms_item w-dyn-item">
  <div class="card_blog_wrap">
    <div class="card_blog_content">
      <div>
        <div class="u-text-style-caption u-foreground-tertiary u-mb-1-5">Feb 20, 2026</div>
        <div class="card_blog_title u-text-style-h6">Common workflow patterns for AI agents</div>
      </div>
    </div>
    <a href="/blog/agent-patterns" class="clickable_link w-inline-block"></a>
  </div>
</div>
</body>
</html>
`;

Deno.test("parseBlogPosts extracts posts from fixture HTML", () => {
  const posts = parseBlogPosts(FIXTURE_HTML);
  assertEquals(posts.length, 2);
  assertEquals(posts[0].title, "Bringing Code Review to Claude Code");
  assertEquals(posts[1].title, "Common workflow patterns for AI agents");
});

Deno.test("parseBlogPosts returns empty array for HTML without posts", () => {
  const html = `<html><body><p>No posts here</p></body></html>`;
  const posts = parseBlogPosts(html);
  assertEquals(posts.length, 0);
});

Deno.test("parseBlogPosts builds full URLs from relative hrefs", () => {
  const posts = parseBlogPosts(FIXTURE_HTML);
  assertEquals(posts[0].link, "https://claude.com/blog/code-review");
  assertEquals(posts[1].link, "https://claude.com/blog/agent-patterns");
});

Deno.test("parseBlogPosts parses dates correctly", () => {
  const posts = parseBlogPosts(FIXTURE_HTML);
  const date = posts[0].published;
  assertEquals(isNaN(date.getTime()), false);
  assertEquals(date.getFullYear(), 2026);
  assertEquals(date.getMonth(), 2); // March = 2
  assertEquals(date.getDate(), 9);
});

Deno.test("parseBlogPosts uses post URL as id", () => {
  const posts = parseBlogPosts(FIXTURE_HTML);
  assertEquals(posts[0].id, "https://claude.com/blog/code-review");
});
