import * as api from "@/lib/api-v1"

export const maxDuration = 60

type Context = { params: Promise<{ id: string }> }

export async function PUT(request: Request, { params }: Context) {
  return api.markRead(request, (await params).id)
}

export async function DELETE(request: Request, { params }: Context) {
  return api.markUnread(request, (await params).id)
}
