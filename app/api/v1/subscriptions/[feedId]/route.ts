import * as api from "@/lib/api-v1"

export const maxDuration = 60

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ feedId: string }> }
) {
  return api.unsubscribe(request, (await params).feedId)
}
