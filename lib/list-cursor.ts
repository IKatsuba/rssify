// The list cursor's pure parts (design §3): moving it, and the return point
// that puts it back on the entry's row after Back. Kept free of React and
// the DOM so tests run them with plain values.

// list: the list's scope (path and filter, no paging), which is all an entry
// URL knows. href: a page of that list holding the entry, so Back lands on
// its row. id: the entry last shown. ids: the rows of that page, to tell
// whether j/k on the entry page has stepped off it.
export type ReturnPoint = {
  list: string
  href: string
  id: string
  ids: string[]
}

export const RETURN_KEY = "rssify:cursor"

export function moveCursor(at: number, step: number, rows: number) {
  return Math.max(0, Math.min(at + step, rows - 1))
}

// The cursor stays at its index when a row leaves; past the end it rests on
// the last row.
export function clampCursor(cursor: number, rows: number) {
  return Math.max(0, Math.min(cursor, rows - 1))
}

export function parseReturn(text: string | null): ReturnPoint | null {
  try {
    const value = JSON.parse(text ?? "null")
    return value &&
      typeof value.list === "string" &&
      typeof value.href === "string" &&
      typeof value.id === "string" &&
      Array.isArray(value.ids) &&
      value.ids.every((id: unknown) => typeof id === "string")
      ? value
      : null
  } catch {
    return null
  }
}

// Where the cursor starts on arriving at the page href: on the saved entry's
// row, else on the first row (pruned, or read under Unread). null when the
// point belongs to another page, including page 1 after an expired cursor.
export function restoreCursor(
  saved: ReturnPoint | null,
  href: string,
  ids: string[]
) {
  if (!saved || saved.href !== href) return null
  return Math.max(ids.indexOf(saved.id), 0)
}

// Back from an entry goes to the saved page when the point is for this
// entry's list, else to the list's first page.
export function backHref(saved: ReturnPoint | null, list: string) {
  return saved?.list === list ? saved.href : list
}

// The point after the entry page shows id, having been reached with j/k.
// Still on the saved page: only the entry changes. Stepped off it: Back
// goes to entryPage, the page of the list that starts at this entry.
export function followEntry(
  saved: ReturnPoint | null,
  list: string,
  id: string,
  entryPage: string
): ReturnPoint | null {
  if (saved?.list !== list || saved.id === id) return null
  if (saved.ids.includes(id)) return { ...saved, id }
  return { list, href: entryPage, id, ids: [id] }
}
