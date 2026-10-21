import { refreshFeed, type RefreshOptions } from "./refresh"

// The fan-out leased the feed already; this only skips what looks like a
// duplicate delivery. A message we cannot read is logged and acknowledged,
// since redelivering it would fail the same way.
export async function refreshFromMessage(
  message: unknown,
  options: Omit<RefreshOptions, "skipIfFreshWithin"> = {}
) {
  const feedId =
    typeof message === "object" && message !== null && "feedId" in message
      ? message.feedId
      : undefined
  if (typeof feedId !== "string") {
    console.error("feed-refresh message without a feedId, dropped")
    return
  }
  return refreshFeed(feedId, { ...options, skipIfFreshWithin: 120 })
}
