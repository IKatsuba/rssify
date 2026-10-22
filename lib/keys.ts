// Pure parts of the reader's keyboard shortcuts (design §3). Nothing here
// imports React or touches the DOM at load time, so tests run it with plain
// objects standing in for the event, storage and document.

export const SHORTCUTS_KEY = "rssify:shortcuts"
const CHANGE_EVENT = "rssify:shortcuts"

export type KeyContext = "list" | "entry"

export type KeyAction =
  | "next"
  | "previous"
  | "open"
  | "back"
  | "toggleRead"
  | "original"
  | "markAll"
  | "refresh"
  | "add"
  | "help"

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">

type TargetLike = {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

type KeyEventLike = {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  target: unknown
}

type QueryRoot = { querySelector: (selectors: string) => unknown }

// Rows carry this attribute so Enter opens the cursor's entry when a row has
// focus, while Enter on a button or link elsewhere keeps its own meaning.
export const ROW_ATTRIBUTE = "data-entry-row"

// Base UI unmounts closed popups, so any of these in the document means a
// dialog, the phone sidebar sheet or a menu is open and owns the keys.
const OPEN_LAYER = '[role="dialog"], [role="alertdialog"], [role="menu"]'

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    // Some browsers throw on access when storage is disabled.
    return null
  }
}

export function shortcutsOn(storage = defaultStorage()) {
  try {
    return storage?.getItem(SHORTCUTS_KEY) !== "off"
  } catch {
    return true
  }
}

export function setShortcutsOn(on: boolean, storage = defaultStorage()) {
  try {
    if (on) storage?.removeItem(SHORTCUTS_KEY)
    else storage?.setItem(SHORTCUTS_KEY, "off")
  } catch {
    // Without storage the switch cannot persist; there is nothing to save.
  }
  globalThis.dispatchEvent?.(new Event(CHANGE_EVENT))
}

// Calls back when this tab flips the switch or another tab changes storage.
export function onShortcutsChange(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SHORTCUTS_KEY || event.key === null) callback()
  }
  globalThis.addEventListener(CHANGE_EVENT, callback)
  globalThis.addEventListener("storage", onStorage)
  return () => {
    globalThis.removeEventListener(CHANGE_EVENT, callback)
    globalThis.removeEventListener("storage", onStorage)
  }
}

function isTypingTarget(target: unknown) {
  if (!target || typeof target !== "object") return false
  const { tagName, isContentEditable } = target as TargetLike
  return (
    isContentEditable === true ||
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT"
  )
}

export function canHandleKey(
  event: KeyEventLike,
  {
    storage = defaultStorage(),
    root = globalThis.document as QueryRoot | undefined,
  }: { storage?: StorageLike | null; root?: QueryRoot } = {}
) {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  if (!shortcutsOn(storage)) return false
  if (isTypingTarget(event.target)) return false
  return !root?.querySelector(OPEN_LAYER)
}

function onBodyOrRow(target: unknown) {
  if (!target || typeof target !== "object") return false
  const element = target as TargetLike
  return (
    element.tagName === "BODY" ||
    Boolean(element.closest?.(`[${ROW_ATTRIBUTE}]`))
  )
}

// Maps a key the guard already let through to what it does in this context;
// null means the key is left to the browser (Space, / and everything else).
export function keyAction(
  event: Pick<KeyEventLike, "key" | "shiftKey" | "target">,
  context: KeyContext
): KeyAction | null {
  const { key, shiftKey } = event
  if (key === "?") return "help"
  if (key === "Enter") {
    return context === "list" && !shiftKey && onBodyOrRow(event.target)
      ? "open"
      : null
  }
  if (key === "Escape") return context === "entry" ? "back" : null
  // Caps Lock gives upper case without Shift, so letters compare lowercased
  // and Shift is read from the event.
  const letter = key.length === 1 ? key.toLowerCase() : ""
  if (letter === "a") return shiftKey ? "markAll" : "add"
  if (shiftKey) return null
  switch (letter) {
    case "j":
      return "next"
    case "k":
      return "previous"
    case "m":
      return "toggleRead"
    case "v":
      return "original"
    case "o":
      return context === "list" ? "open" : null
    case "u":
      return context === "entry" ? "back" : null
    case "r":
      return context === "list" ? "refresh" : null
    default:
      return null
  }
}

// ⌘ on Apple platforms, Ctrl elsewhere; the caller passes navigator.platform
// or userAgent so this stays testable and server code can default to Ctrl.
export function modifierLabel(platform: string) {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "⌘" : "Ctrl"
}

export function shiftLabel(platform: string) {
  return modifierLabel(platform) === "⌘" ? "⇧" : "Shift"
}
