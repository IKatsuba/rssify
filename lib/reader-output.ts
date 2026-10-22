import { addFeedError } from "@/lib/add-feed-errors"
import * as reader from "@/lib/reader"

// What /api/v1 and MCP say back (design §5.5): the same bodies and the same
// sentences, so a client sees one API whichever door it came through.

export type ErrorBody = { code: string; message: string; choices?: string[] }

// What Response.json does to a value, for adapters that are not a Response.
export function toJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value))
}

export function readerErrorBody(e: reader.ReaderError): ErrorBody {
  return e.code === "invalid_cursor"
    ? { code: "invalid_input", message: "Invalid cursor" }
    : { code: "not_found", message: "Not found" }
}

export function subscribeErrorBody(
  { code, choices }: { code: string; choices?: string[] },
  input: reader.SubscribeInput
): ErrorBody {
  // The sentence names the host the caller sent; a source has none.
  const message = addFeedError(code, "url" in input ? input.url : "")
  return { code, message, ...(choices && { choices }) }
}

// The subscription as list_feeds and GET /subscriptions show it.
export async function subscriptionOf(userId: string, feedId: string) {
  return (await reader.listSubscriptions(userId)).find(
    (s) => s.feed.id === feedId
  )
}
