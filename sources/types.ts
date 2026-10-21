import type { IngestedEntry } from "@/lib/ingest/parse"
import type { SafeFetch } from "@/lib/ingest/safe-fetch"

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
