import { assertEquals } from "@std/assert";
import { hasContent, parseHTML } from "./scraper.ts";

Deno.test("hasContent returns true for HTML with substantial text", () => {
  const html = `<html><body><p>${"a".repeat(201)}</p></body></html>`;
  assertEquals(hasContent(html), true);
});

Deno.test("hasContent returns false for minimal HTML", () => {
  const html = `<html><body><p>short</p></body></html>`;
  assertEquals(hasContent(html), false);
});

Deno.test("hasContent returns false for empty HTML", () => {
  const html = `<html><body></body></html>`;
  assertEquals(hasContent(html), false);
});

Deno.test("parseHTML returns a valid Document that supports querySelector", () => {
  const html = `<html><body><div id="main"><p class="intro">Hello</p></div></body></html>`;
  const doc = parseHTML(html);
  const el = doc?.querySelector("p.intro");
  assertEquals(el?.textContent, "Hello");
});
