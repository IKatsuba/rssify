import * as api from "@/lib/api-v1"

export const maxDuration = 60

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return api.getEntry(request, (await params).id)
}
