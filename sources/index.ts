import { anthropicEngineering, anthropicNews } from "./anthropic"
import { bytes } from "./bytes"
import { cursorBlog } from "./cursor-blog"
import { githubTrending } from "./github-trending"
import type { SourcePlugin } from "./types"

// Registering a plugin is a code change.
export const plugins: Record<string, SourcePlugin> = {
  "anthropic-engineering": anthropicEngineering,
  "anthropic-news": anthropicNews,
  bytes,
  "cursor-blog": cursorBlog,
  "github-trending": githubTrending,
}

// The plugin owning an address, with the URL it stores for it. Shapes are
// disjoint, so the first match is the only one. Object.values reads own
// keys only, so a name on the prototype is no plugin.
export function pluginFor(
  url: string,
  registry: Record<string, SourcePlugin> = plugins
): { plugin: SourcePlugin; url: string } | undefined {
  for (const plugin of Object.values(registry)) {
    let parsed
    try {
      // A fresh URL each time, so one plugin cannot change another's input.
      parsed = new URL(url)
    } catch {
      return undefined
    }
    const canonical = plugin.canonical(parsed)
    if (canonical !== null) return { plugin, url: canonical }
  }
  return undefined
}
