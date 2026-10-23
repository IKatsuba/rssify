import { auth } from "@/lib/auth"

// RFC 9728 metadata at the root and at …/api/mcp. The auth catch-all only
// sees /api/auth/*, so these root URLs are handed to better-auth here, where
// mcp()'s onRequest answers them.
export function GET(request: Request) {
  return auth.handler(request)
}
