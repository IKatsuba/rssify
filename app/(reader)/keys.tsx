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
  shiftLabel,
} from "@/lib/keys"

import { Kbd, KbdGroup } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

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
  const labels = useKeyLabels()

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
        labels={labels}
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

export type KeyLabels = { mod: string; shift: string }

// The platform's key names for hints: ⌘ and ⇧ on macOS, Ctrl and Shift
// elsewhere. The server and the first client render use the latter.
export function useKeyLabels(): KeyLabels {
  const platform = useSyncExternalStore(
    () => () => {},
    () => navigator.platform,
    () => ""
  )
  return { mod: modifierLabel(platform), shift: shiftLabel(platform) }
}

// "mod" and "shift" in keys stand for the platform's names.
export function keyNames(keys: string[], labels: KeyLabels) {
  return keys.map((key) =>
    key === "mod" ? labels.mod : key === "shift" ? labels.shift : key
  )
}

// A menu item's shortcut text: ⇧A on macOS, Shift+A elsewhere.
export function menuShortcut(keys: string[], labels: KeyLabels) {
  return keyNames(keys, labels).join(labels.shift === "⇧" ? "" : "+")
}

// A control's tooltip with its key (design §3: "Next J"). render is the
// control itself; a disabled one shows no tooltip.
export function KeyHint({
  label,
  keys,
  render,
  children,
}: {
  label: string
  keys: string[]
  render: React.ComponentProps<typeof TooltipTrigger>["render"]
  children: React.ReactNode
}) {
  const labels = useKeyLabels()
  return (
    <Tooltip>
      <TooltipTrigger render={render}>{children}</TooltipTrigger>
      <TooltipContent>
        {label}
        <KbdGroup>
          {keyNames(keys, labels).map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </KbdGroup>
      </TooltipContent>
    </Tooltip>
  )
}
