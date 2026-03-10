import { assertEquals } from "@std/assert";
import { parseEmbeddedPosts } from "./claude-code.ts";

const FIXTURE_HTML = `
<!DOCTYPE html>
<html>
<head><title>Research</title></head>
<body>
<script>self.__next_f.push([1,"some-prefix-data"])</script>
<script>self.__next_f.push([1,"{\\"_type\\":\\"post\\",\\"title\\":\\"Test Post One\\",\\"slug\\":{\\"_type\\":\\"slug\\",\\"current\\":\\"test-post-one\\"},\\"publishedOn\\":\\"2026-01-15T10:00:00.000Z\\",\\"summary\\":\\"A summary of the first test post\\",\\"subjects\\":[{\\"_key\\":\\"alignment\\",\\"_type\\":\\"tag\\",\\"label\\":\\"Alignment\\",\\"value\\":\\"alignment\\"}],\\"directories\\":[{\\"_key\\":\\"research\\",\\"_type\\":\\"tag\\",\\"label\\":\\"Research\\",\\"value\\":\\"research\\"}]}"])</script>
<script>self.__next_f.push([1,"{\\"_type\\":\\"post\\",\\"title\\":\\"Test Post Two\\",\\"slug\\":{\\"_type\\":\\"slug\\",\\"current\\":\\"test-post-two\\"},\\"publishedOn\\":\\"2026-02-20T14:30:00.000Z\\",\\"summary\\":null,\\"subjects\\":[],\\"directories\\":[]}"])</script>
</body>
</html>
`;

Deno.test("parseEmbeddedPosts extracts posts from fixture HTML", () => {
  const posts = parseEmbeddedPosts(FIXTURE_HTML);
  assertEquals(posts.length, 2);
  assertEquals(posts[0].title, "Test Post One");
  assertEquals(posts[1].title, "Test Post Two");
});

Deno.test("parseEmbeddedPosts returns empty array for HTML without posts", () => {
  const html = `<html><body><p>No posts here</p></body></html>`;
  const posts = parseEmbeddedPosts(html);
  assertEquals(posts.length, 0);
});

Deno.test("parseEmbeddedPosts correctly maps slug to current value", () => {
  const posts = parseEmbeddedPosts(FIXTURE_HTML);
  assertEquals(posts[0].slug.current, "test-post-one");
  assertEquals(posts[1].slug.current, "test-post-two");
});

Deno.test("parseEmbeddedPosts parses publishedOn as valid date string", () => {
  const posts = parseEmbeddedPosts(FIXTURE_HTML);
  const date = new Date(posts[0].publishedOn);
  assertEquals(isNaN(date.getTime()), false);
  assertEquals(date.getFullYear(), 2026);
});

Deno.test("parseEmbeddedPosts extracts subject labels", () => {
  const posts = parseEmbeddedPosts(FIXTURE_HTML);
  assertEquals(posts[0].subjects.length, 1);
  assertEquals(posts[0].subjects[0].label, "Alignment");
  assertEquals(posts[1].subjects.length, 0);
});

Deno.test("parseEmbeddedPosts handles null summary", () => {
  const posts = parseEmbeddedPosts(FIXTURE_HTML);
  assertEquals(posts[0].summary, "A summary of the first test post");
  assertEquals(posts[1].summary, null);
});
