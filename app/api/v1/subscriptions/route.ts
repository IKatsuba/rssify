import * as api from "@/lib/api-v1"

// Subscribing may fetch the feed, as the add-feed action does.
export const maxDuration = 60

export function GET(request: Request) {
  return api.listSubscriptions(request)
}

export function POST(request: Request) {
  return api.subscribe(request)
}
