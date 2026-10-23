import { cache } from "react"

import { requireUser } from "@/lib/actor"
import { listSubscriptions } from "@/lib/reader"

// Once per request: the layout, its metadata and the pages all ask.
export const currentUser = cache(requireUser)
export const subscriptionsOf = cache(listSubscriptions)

export async function totalUnread(userId: string) {
  const subscriptions = await subscriptionsOf(userId)
  return subscriptions.reduce((sum, s) => sum + s.unreadCount, 0)
}
