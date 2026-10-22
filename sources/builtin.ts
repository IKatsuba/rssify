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
    note: "cursor.com/blog — no feed of its own",
  },
  {
    id: "langchain-blog",
    title: "LangChain blog",
    url: "https://www.langchain.com/blog/rss.xml",
    note: "The LangChain blog’s own feed",
  },
  {
    id: "nodejs-blog",
    title: "Node.js blog",
    url: "https://nodejs.org/en/feed/blog.xml",
    note: "nodejs.org — the Node.js blog’s own feed",
  },
] as const

export type BuiltinSource = (typeof builtinSources)[number]

export function builtinSource(id: string): BuiltinSource | undefined {
  return builtinSources.find((source) => source.id === id)
}
