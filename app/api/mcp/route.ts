import { mcpPost } from "@/lib/mcp/route"

// subscribe may fetch the feed, as the add-feed action does.
export const maxDuration = 60

// Only POST: stateless serving answers GET and DELETE with 405 anyway, and
// without an export Next.js does the same.
export function POST(request: Request) {
  return mcpPost(request)
}
