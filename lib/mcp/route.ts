import {
  createMcpHandler,
  originValidationResponse,
} from "@modelcontextprotocol/server"

import { requireApiKey, withMcpAuth } from "@/lib/actor"
import type { SubscribeOptions } from "@/lib/reader"

import { buildMcpServer } from "./server"

// POST /api/mcp (design §5.5). A fresh handler and server per request:
// nothing is kept between requests but Postgres.
function serve(request: Request, userId: string, options?: SubscribeOptions) {
  return createMcpHandler(() => buildMcpServer(userId, options), {
    legacy: "stateless",
  }).fetch(request)
}

// A browser page on another site must not drive the endpoint; clients that
// send no Origin are not browsers and pass.
const allowedHostnames = () => [new URL(process.env.BETTER_AUTH_URL!).hostname]

// options is the test seam reader.subscribe has; the route passes nothing.
export async function mcpPost(request: Request, options?: SubscribeOptions) {
  const refused = originValidationResponse(request, allowedHostnames())
  if (refused) return refused
  // A present x-api-key is the /api/v1 check, refusals and all; otherwise
  // only an OAuth access token for this resource. No cookie is read here.
  if (request.headers.has("x-api-key")) {
    const actor = await requireApiKey(request.headers)
    if (actor instanceof Response) return actor
    return serve(request, actor.userId, options)
  }
  return withMcpAuth((authorised, actor) =>
    serve(authorised, actor.userId, options)
  )(request)
}
