"use client"

import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import {
  canHandleKey,
  keyAction,
  type KeyAction,
  type KeyContext,
  modifierLabel,
} from "@/lib/keys"

import { useAddFeed } from "./add-feed"
import { ShortcutsDialog } from "./shortcuts-dialog"

// A handler returning false declines the key, so the browser keeps it.
type Handlers = Partial<Record<KeyAction, () => boolean | void>>
type Registration = { context?: KeyContext; handlers: () => Handlers }

const KeysContext = createContext<{
  registrations: Set<Registration>
  showShortcuts: () => void
}>({ registrations: new Set(), showShortcuts: () => {} })

// The one key listener for the reader (design §3). Pages and controls add
// their handlers with useKeys; Add a feed and the shortcuts dialog are the
// same everywhere.
export function KeysProvider({ children }: { children: React.ReactNode }) {
  const addFeed = useAddFeed()
  const [registrations] = useState(() => new Set<Registration>())
  const [shortcuts, setShortcuts] = useState(false)
  const [value] = useState(() => ({
    registrations,
    showShortcuts: () => setShortcuts(true),
  }))
  const modifier = useModifierLabel()

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || !canHandleKey(event)) {
        return
      }
      const all = [...registrations]
      const context = all.find((r) => r.context)?.context ?? "list"
      const action = keyAction(event, context)
      if (!action) return
      const handler =
        action === "add"
          ? addFeed
          : action === "help"
            ? value.showShortcuts
            : all.map((r) => r.handlers()[action]).find(Boolean)
      if (handler && handler() !== false) event.preventDefault()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [registrations, addFeed, value])

  return (
    <KeysContext value={value}>
      {children}
      <ShortcutsDialog
        open={shortcuts}
        modifier={modifier}
        onOpenChange={setShortcuts}
      />
    </KeysContext>
  )
}

// Handlers are read when a key arrives, so they always see the latest
// render's state without re-registering.
export function useKeys(handlers: Handlers, context?: KeyContext) {
  const { registrations } = use(KeysContext)
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })
  useEffect(() => {
    const registration = { context, handlers: () => latest.current }
    registrations.add(registration)
    return () => {
      registrations.delete(registration)
    }
  }, [registrations, context])
}

export function useShowShortcuts() {
  return use(KeysContext).showShortcuts
}

// The platform's modifier for key hints; the server and the first client
// render say Ctrl, then macOS switches to ⌘.
export function useModifierLabel() {
  return useSyncExternalStore(
    () => () => {},
    () => modifierLabel(navigator.platform),
    () => "Ctrl"
  )
}
