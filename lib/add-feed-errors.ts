// Client-side too, so no import that reaches the database.
function hostOf(input: string) {
  try {
    return new URL(input.trim()).host || input.trim()
  } catch {
    return input.trim()
  }
}

// The add dialog's sentence for each subscribe code (design §4). {host}
// comes from what the person typed, so it names the site they recognise.
export function addFeedError(code: string, input: string) {
  const host = hostOf(input)
  switch (code) {
    case "invalid_url":
      return "That doesn’t look like a web address."
    case "blocked":
      return "That address can’t be fetched from here."
    case "unreachable":
      return `We couldn’t reach ${host}. Check the address and try again.`
    case "not_found":
      return "We couldn’t find a feed at that address. Try the site’s feed URL directly."
    case "too_large":
      return "That feed is too large to read (over 10 MB)."
    case "limit":
      return "You follow 500 feeds, the most rssify allows. Unsubscribe from one first."
    case "multiple":
      return `${host} has more than one feed. Pick one.`
    default:
      return "We couldn’t add that feed. Try again."
  }
}
