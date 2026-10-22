// The list cursor's pure parts (design §3): moving it, and the return point
// that puts it back on the entry's row after Back. Kept free of React and
// the DOM so tests run them with plain values.

// list: the list's scope (path and filter, no paging), which is all an entry
// URL knows. href: the exact page the entry was opened from, so Back from an
// Older entries page lands on that page. id: the entry last shown. index:
// where it was opened, for when its row has left an Unread list.
export type ReturnPoint = {
  list: string
  href: string
  id: string
  index: number
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
      Number.isInteger(value.index) &&
      value.index >= 0
      ? value
      : null
  } catch {
    return null
  }
}

// Where the cursor starts on arriving at the page href: on the saved entry's
// row, else at its saved index. null when the point belongs to another page,
// including page 1 after an expired cursor sent the person there.
export function restoreCursor(
  saved: ReturnPoint | null,
  href: string,
  ids: string[]
) {
  if (!saved || saved.href !== href) return null
  const index = ids.indexOf(saved.id)
  return index >= 0 ? index : clampCursor(saved.index, ids.length)
}

// Back from an entry goes to the page it was opened from when the saved
// point is for this entry's list, else to the list's first page.
export function backHref(saved: ReturnPoint | null, list: string) {
  return saved?.list === list ? saved.href : list
}

// Stepping with j/k on the entry page keeps the point on the entry shown.
export function followEntry(
  saved: ReturnPoint | null,
  list: string,
  id: string
) {
  return saved?.list === list && saved.id !== id ? { ...saved, id } : null
}
