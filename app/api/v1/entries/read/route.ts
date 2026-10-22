import * as api from "@/lib/api-v1"

export const maxDuration = 60

export function POST(request: Request) {
  return api.markAllRead(request)
}
