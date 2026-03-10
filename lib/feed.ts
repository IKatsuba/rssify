import { Atom } from "@feed/feed";
import type { FeedEntry, FeedMeta } from "./types.ts";

export function buildAtomFeed(meta: FeedMeta, entries: FeedEntry[]): string {
  const feed = new Atom({
    title: meta.title,
    description: meta.description,
    link: meta.link,
    id: meta.id,
    updated: entries.length > 0 ? entries[0].published : new Date(),
    authors: [{ name: meta.author, email: "" }],
  });

  for (const entry of entries) {
    feed.addItem({
      title: entry.title,
      link: entry.link,
      id: entry.id,
      updated: entry.published,
      summary: entry.summary ?? "",
      content: entry.content
        ? { body: entry.content, type: "html" }
        : undefined,
    });
  }

  return feed.build();
}
