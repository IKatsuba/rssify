import type { SourcePlugin } from "./types"

// Registering a plugin is a code change; cursor-blog arrives with RSSF-9.
export const plugins: Record<string, SourcePlugin> = {}

// Only an exact match: a plugin owns its list page's URL, nothing else.
export function pluginFor(
  url: string,
  registry: Record<string, SourcePlugin> = plugins
): SourcePlugin | undefined {
  return Object.values(registry).find((plugin) => plugin.matches === url)
}
