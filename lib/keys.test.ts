import { describe, expect, test } from "bun:test"

import {
  canHandleKey,
  keyAction,
  modifierLabel,
  setShortcutsOn,
  shiftLabel,
  SHORTCUTS_KEY,
  shortcutsOn,
  type KeyContext,
} from "./keys"

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  }
}

const body = { tagName: "BODY", closest: () => null }
const row = { tagName: "A", closest: (s: string) => (s ? {} : null) }
const button = { tagName: "BUTTON", closest: () => null }

function press(
  key: string,
  overrides: Partial<{
    shiftKey: boolean
    metaKey: boolean
    ctrlKey: boolean
    altKey: boolean
    target: unknown
  }> = {}
) {
  return {
    key,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    target: body,
    ...overrides,
  }
}

const closedDom = { querySelector: () => null }

describe("canHandleKey", () => {
  const env = { storage: memoryStorage(), root: closedDom }

  test("passes a plain key on the page", () => {
    expect(canHandleKey(press("j"), env)).toBe(true)
  })

  test("passes Shift", () => {
    expect(canHandleKey(press("A", { shiftKey: true }), env)).toBe(true)
  })

  test("refuses any other modifier", () => {
    expect(canHandleKey(press("j", { metaKey: true }), env)).toBe(false)
    expect(canHandleKey(press("j", { ctrlKey: true }), env)).toBe(false)
    expect(canHandleKey(press("j", { altKey: true }), env)).toBe(false)
  })

  test("refuses keys typed into a field", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(canHandleKey(press("j", { target: { tagName } }), env)).toBe(false)
    }
    expect(
      canHandleKey(
        press("j", { target: { tagName: "DIV", isContentEditable: true } }),
        env
      )
    ).toBe(false)
  })

  test("refuses while a dialog, sheet or menu is open", () => {
    const selectors: string[] = []
    const openDom = {
      querySelector: (s: string) => (selectors.push(s), {}),
    }
    expect(canHandleKey(press("j"), { ...env, root: openDom })).toBe(false)
    expect(selectors[0]).toContain('[role="dialog"]')
    expect(selectors[0]).toContain('[role="alertdialog"]')
    expect(selectors[0]).toContain('[role="menu"]')
  })

  test("refuses when shortcuts are switched off", () => {
    const storage = memoryStorage({ [SHORTCUTS_KEY]: "off" })
    expect(canHandleKey(press("j"), { storage, root: closedDom })).toBe(false)
  })
})

describe("shortcuts switch", () => {
  test("is on unless stored as off", () => {
    expect(shortcutsOn(memoryStorage())).toBe(true)
    expect(shortcutsOn(memoryStorage({ [SHORTCUTS_KEY]: "on" }))).toBe(true)
    expect(shortcutsOn(memoryStorage({ [SHORTCUTS_KEY]: "off" }))).toBe(false)
  })

  test("writes off and clears it again", () => {
    const storage = memoryStorage()
    setShortcutsOn(false, storage)
    expect(storage.values.get(SHORTCUTS_KEY)).toBe("off")
    expect(shortcutsOn(storage)).toBe(false)
    setShortcutsOn(true, storage)
    expect(storage.values.has(SHORTCUTS_KEY)).toBe(false)
  })

  test("treats storage that throws as on", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
      removeItem: () => {
        throw new Error("denied")
      },
    }
    expect(shortcutsOn(broken)).toBe(true)
    expect(() => setShortcutsOn(false, broken)).not.toThrow()
  })
})

describe("keyAction", () => {
  const cases: [string, boolean, KeyContext, string | null][] = [
    ["j", false, "list", "next"],
    ["k", false, "list", "previous"],
    ["o", false, "list", "open"],
    ["Enter", false, "list", "open"],
    ["m", false, "list", "toggleRead"],
    ["v", false, "list", "original"],
    ["A", true, "list", "markAll"],
    ["r", false, "list", "refresh"],
    ["a", false, "list", "add"],
    ["?", true, "list", "help"],
    ["u", false, "list", null],
    ["Escape", false, "list", null],
    ["j", false, "entry", "next"],
    ["k", false, "entry", "previous"],
    ["u", false, "entry", "back"],
    ["Escape", false, "entry", "back"],
    ["m", false, "entry", "toggleRead"],
    ["v", false, "entry", "original"],
    ["A", true, "entry", "markAll"],
    ["a", false, "entry", "add"],
    ["?", true, "entry", "help"],
    ["o", false, "entry", null],
    ["Enter", false, "entry", null],
    ["r", false, "entry", null],
    [" ", false, "list", null],
    ["/", false, "list", null],
    [" ", false, "entry", null],
    ["/", false, "entry", null],
    ["d", false, "list", null],
    ["J", true, "list", null],
  ]

  for (const [key, shiftKey, context, action] of cases) {
    test(`${shiftKey ? "Shift+" : ""}${key} in ${context} → ${action}`, () => {
      expect(keyAction(press(key, { shiftKey }), context)).toBe(action as never)
    })
  }

  test("reads letters under Caps Lock as the same keys", () => {
    expect(keyAction(press("J"), "list")).toBe("next")
    expect(keyAction(press("A"), "list")).toBe("add")
  })

  test("Enter opens only from the page body or a row", () => {
    expect(keyAction(press("Enter", { target: row }), "list")).toBe("open")
    expect(keyAction(press("Enter", { target: button }), "list")).toBeNull()
    expect(keyAction(press("o", { target: button }), "list")).toBe("open")
  })
})

describe("modifierLabel", () => {
  test("⌘ on Apple platforms, Ctrl elsewhere", () => {
    expect(modifierLabel("MacIntel")).toBe("⌘")
    expect(modifierLabel("iPhone")).toBe("⌘")
    expect(modifierLabel("Win32")).toBe("Ctrl")
    expect(modifierLabel("Linux x86_64")).toBe("Ctrl")
    expect(modifierLabel("")).toBe("Ctrl")
  })
})

describe("shiftLabel", () => {
  test("⇧ on Apple platforms, Shift elsewhere", () => {
    expect(shiftLabel("MacIntel")).toBe("⇧")
    expect(shiftLabel("Win32")).toBe("Shift")
  })
})
