// What the add dialog lists and what { source } maps to a URL.
export const builtinSources = [
  {
    id: "anthropic-engineering",
    title: "Anthropic engineering",
    url: "https://www.anthropic.com/engineering",
    note: "anthropic.com/engineering — no feed of its own",
  },
  {
    id: "anthropic-news",
    title: "Anthropic news",
    url: "https://www.anthropic.com/news",
    note: "anthropic.com/news — no feed of its own",
  },
  {
    id: "bytes",
    title: "Bytes",
    url: "https://bytes.dev/archives",
    note: "bytes.dev — no feed of its own",
  },
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
    id: "firefox-releases",
    title: "Firefox release notes",
    url: "https://www.firefox.com/en-US/releases/",
    note: "firefox.com — desktop release notes, no feed of their own",
  },
  {
    id: "langchain-blog",
    title: "LangChain blog",
    url: "https://www.langchain.com/blog/rss.xml",
    note: "langchain.com — the LangChain blog’s own feed",
  },
  {
    id: "nodejs-blog",
    title: "Node.js blog",
    url: "https://nodejs.org/en/feed/blog.xml",
    note: "nodejs.org — the Node.js blog’s own feed",
  },
  {
    id: "perplexity-developers",
    title: "Perplexity developers",
    url: "https://www.perplexity.ai/hub/blog/category/developers",
    note: "www.perplexity.ai — no feed of its own",
  },
  {
    id: "perplexity-research",
    title: "Perplexity research",
    url: "https://www.perplexity.ai/hub/blog/category/research",
    note: "www.perplexity.ai — no feed of its own",
  },
] as const

export type BuiltinSource = (typeof builtinSources)[number]

export function builtinSource(id: string): BuiltinSource | undefined {
  return builtinSources.find((source) => source.id === id)
}
