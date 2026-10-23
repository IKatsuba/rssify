import { describe, expect, test } from "bun:test"

import {
  canHandleKey,
  keyAction,
  onShortcutsChange,
  setShortcutsOn,
  SHORTCUTS_KEY,
  shortcutsOn,
} from "./keys"

const body = { tagName: "BODY" }
const press = (key: string, target: unknown = body, shiftKey = false) => ({
  key,
  target,
  shiftKey,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
})

// Keep browser event subscriptions isolated from other test files in Bun.
function withBrowserEvents(check: (events: EventTarget) => void) {
  const events = new EventTarget()
  const methods = [
    "addEventListener",
    "removeEventListener",
    "dispatchEvent",
  ] as const
  const saved = methods.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name)
  )
  try {
    for (const name of methods) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value: events[name].bind(events),
      })
    }
    check(events)
  } finally {
    methods.forEach((name, index) => {
      const descriptor = saved[index]
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    })
  }
}

describe("RSSF-12 U1 tester edge cases", () => {
  test("switch changes notify this tab even when persistence is unavailable", () => {
    withBrowserEvents(() => {
      let changes = 0
      const stop = onShortcutsChange(() => changes++)
      const unavailable = {
        getItem: () => {
          throw new Error("storage unavailable")
        },
        setItem: () => {
          throw new Error("storage unavailable")
        },
        removeItem: () => {
          throw new Error("storage unavailable")
        },
      }
      try {
        setShortcutsOn(false, unavailable)
        setShortcutsOn(true, unavailable)
        expect(changes).toBe(2)
        expect(shortcutsOn(unavailable)).toBe(true)
      } finally {
        stop()
      }
    })
  })

  test("cross-tab changes and clear notify, unrelated storage does not, teardown removes both listeners", () => {
    withBrowserEvents((events) => {
      let changes = 0
      const stop = onShortcutsChange(() => changes++)
      const changed = (key: string | null) => {
        const event = new Event("storage")
        Object.defineProperty(event, "key", { value: key })
        events.dispatchEvent(event)
      }
      try {
        changed("theme")
        expect(changes).toBe(0)
        changed(SHORTCUTS_KEY)
        changed(null)
        expect(changes).toBe(2)
      } finally {
        stop()
      }
      changed(SHORTCUTS_KEY)
      setShortcutsOn(false, null)
      expect(changes).toBe(2)
    })
  })

  test("only the exact off value disables keys, and the guard observes changes on every call", () => {
    let value: string | null = null
    const storage = {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next
      },
      removeItem: () => {
        value = null
      },
    }
    const env = { storage, root: { querySelector: () => null } }
    for (const enabled of [null, "", "false", "OFF", "on"]) {
      value = enabled
      expect(canHandleKey(press("j"), env)).toBe(true)
    }
    value = "off"
    expect(canHandleKey(press("j"), env)).toBe(false)
    value = null
    expect(canHandleKey(press("j"), env)).toBe(true)
  })

  test("Enter distinguishes row descendants from unrelated controls and Shift+Enter", () => {
    const descendant = {
      tagName: "SPAN",
      closest: (selector: string) =>
        selector === "[data-entry-row]" ? {} : null,
    }
    expect(keyAction(press("Enter", descendant), "list")).toBe("open")
    for (const target of [
      null,
      {},
      { tagName: "A", closest: () => null },
      body,
      descendant,
    ]) {
      expect(keyAction(press("Enter", target, true), "list")).toBeNull()
    }
    expect(keyAction(press("Enter", null), "list")).toBeNull()
    expect(
      keyAction(press("Enter", { tagName: "A", closest: () => null }), "list")
    ).toBeNull()
  })

  test("shifted letters stay unassigned except Shift+A, while Caps Lock keeps plain actions", () => {
    for (const context of ["list", "entry"] as const) {
      for (const key of ["J", "K", "M", "V", "O", "U", "R", "D", "B"]) {
        expect(keyAction(press(key, body, true), context)).toBeNull()
      }
      for (const [key, action] of [
        ["J", "next"],
        ["K", "previous"],
        ["M", "toggleRead"],
        ["V", "original"],
        ["A", "add"],
      ] as const) {
        expect(keyAction(press(key), context)).toBe(action)
      }
      for (const key of [
        " ",
        "/",
        "ArrowDown",
        "ArrowUp",
        "Tab",
        "Home",
        "End",
      ]) {
        expect(keyAction(press(key), context)).toBeNull()
      }
    }
  })
})
