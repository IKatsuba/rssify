import { assertEquals } from "@std/assert";
import { app } from "./main.ts";

Deno.test("GET /health returns 200 with status ok", async () => {
  const res = await app.request("/health");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, "ok");
});

Deno.test("GET / lists available feeds", async () => {
  const res = await app.request("/");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(Array.isArray(body.feeds), true);
  assertEquals(body.feeds.length > 0, true);
  assertEquals(body.feeds[0].name, "blogs/claude-code");
  assertEquals(body.feeds[0].url, "/blogs/claude-code");
});

Deno.test("GET /unknown/route returns 404", async () => {
  const res = await app.request("/unknown/route");
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, "Feed not found");
});

Deno.test("GET /blogs/claude-code returns Atom XML with correct Content-Type", async () => {
  // This test hits the real Anthropic website
  const res = await app.request("/blogs/claude-code");
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("content-type"),
    "application/atom+xml; charset=utf-8",
  );
  const body = await res.text();
  assertEquals(body.includes("<feed"), true);
  assertEquals(body.includes("xmlns=\"http://www.w3.org/2005/Atom\""), true);
});
