// What the add dialog lists and what { source } maps to a URL.
export const builtinSources = [
  {
    id: "claude-code",
    title: "Claude Code blog",
    url: "https://claude.dev/rss.xml",
    note: "claude.dev — the Claude Code blog’s own feed",
  },
  {
    id: "cursor-blog",
    title: "Cursor blog",
    url: "https://cursor.com/blog",
    note: "No feed of its own",
  },
] as const

export type BuiltinSource = (typeof builtinSources)[number]

export function builtinSource(id: string): BuiltinSource | undefined {
  return builtinSources.find((source) => source.id === id)
}
