"use client"

import { useEffect, useSyncExternalStore } from "react"

import {
  backHref,
  followEntry,
  parseReturn,
  RETURN_KEY,
  type ReturnPoint,
} from "@/lib/list-cursor"

// The return point lives in sessionStorage: per tab, gone with it, and never
// on the server. Storage that throws just means Back starts on page 1.
function storedText() {
  try {
    return sessionStorage.getItem(RETURN_KEY)
  } catch {
    return null
  }
}

export function readReturn() {
  return parseReturn(storedText())
}

// sessionStorage raises no event in its own tab, so Back hears this one.
const CHANGE_EVENT = "rssify:cursor"

export function writeReturn(value: ReturnPoint) {
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify(value))
  } catch {
    // Without storage Back starts on the list's first page and first row.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback)
  return () => window.removeEventListener(CHANGE_EVENT, callback)
}

export function clearReturn() {
  try {
    sessionStorage.removeItem(RETURN_KEY)
  } catch {
    // Nothing stored to clear.
  }
}

// The entry page keeps the point on the entry it shows, so Back after j/k
// lands on the last entry read, not the one first opened. entryPage is the
// list page that starts at this entry.
export function useFollowEntry(list: string, id: string, entryPage: string) {
  useEffect(() => {
    const next = followEntry(readReturn(), list, id, entryPage)
    if (next) writeReturn(next)
  }, [list, id, entryPage])
}

// The page Back goes to. The server and the first render use the list's
// first page; the client then switches to the page the entry came from.
export function useBackHref(list: string) {
  const text = useSyncExternalStore(subscribe, storedText, () => null)
  return backHref(parseReturn(text), list)
}
