import * as api from "@/lib/api-v1"

export const maxDuration = 60

export function GET(request: Request) {
  return api.listEntries(request)
}
