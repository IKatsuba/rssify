import { cursorBlog } from "./cursor-blog"
import type { SourcePlugin } from "./types"

// Registering a plugin is a code change.
export const plugins: Record<string, SourcePlugin> = {
  "cursor-blog": cursorBlog,
}

// Only an exact match: a plugin owns its list page's URL, nothing else.
export function pluginFor(
  url: string,
  registry: Record<string, SourcePlugin> = plugins
): SourcePlugin | undefined {
  return Object.values(registry).find((plugin) => plugin.matches === url)
}
