import type { IngestedEntry } from "@/lib/ingest/parse"
import type { SafeFetch } from "@/lib/ingest/safe-fetch"

// A plugin's list page answered non-2xx. It carries the response so
// refreshFeed can treat it as it treats a feed's answer (410, Retry-After).
export class SourceStatusError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Headers
  ) {
    super(`The list page answered ${status}`)
    this.name = "SourceStatusError"
  }
}

// A scraper for a site without a feed.
export interface SourcePlugin {
  id: string // stored on Feed.pluginId; never renamed without a migration
  // Pure, no I/O: the stored URL for an address this plugin owns, else null.
  canonical(url: URL): string | null
  // The title of a new feed; a built-in source’s title wins.
  title?(url: string): string
  fetchEntries(ctx: {
    url: string // the stored, canonical Feed.url; plugins parse it
    fetch: SafeFetch
    known(urls: string[]): Promise<Set<string>>
    deadline: AbortSignal
  }): Promise<IngestedEntry[]>
}
