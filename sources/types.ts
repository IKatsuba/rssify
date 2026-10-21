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
  id: string // stored on Feed.pluginId
  matches: string // the list-page URL; Feed.url for its feed
  fetchEntries(ctx: {
    fetch: SafeFetch
    known(urls: string[]): Promise<Set<string>>
    deadline: AbortSignal
  }): Promise<IngestedEntry[]>
}
