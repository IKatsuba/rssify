"use client"

import { useSyncExternalStore } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import { onShortcutsChange, setShortcutsOn, shortcutsOn } from "@/lib/keys"

import { keyNames, type KeyLabels } from "./keys"

// The ? dialog (design §2.5, desktop-shortcuts.png). Its switch is how a
// person turns single-letter keys back on, so the dialog also opens from
// the email menu, where it does not depend on the keys themselves.
export function ShortcutsDialog({
  open,
  labels,
  onOpenChange,
}: {
  open: boolean
  labels: KeyLabels
  onOpenChange: (open: boolean) => void
}) {
  const on = useSyncExternalStore(onShortcutsChange, shortcutsOn, () => true)
  const rows: [string, string[]][] = [
    ["Next entry", ["J"]],
    ["Previous entry", ["K"]],
    ["Open entry", ["O"]],
    ["Back to list", ["U"]],
    ["Mark read / unread", ["M"]],
    ["Open original in a new tab", ["V"]],
    ["Mark all as read", ["shift", "A"]],
    ["Reload list", ["R"]],
    ["Add a feed", ["A"]],
    ["Toggle sidebar", ["mod", "B"]],
    ["Toggle dark mode", ["D"]],
    ["Show this list", ["?"]],
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Enter also opens the selected entry, and Esc goes back to the list.
          </DialogDescription>
        </DialogHeader>
        <Table>
          <TableBody>
            {rows.map(([label, keys]) => (
              <TableRow key={label}>
                <TableCell>{label}</TableCell>
                <TableCell className="text-right">
                  <KbdGroup>
                    {keyNames(keys, labels).map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </KbdGroup>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShortcutsOn(!on)}>
            {on ? "Turn shortcuts off" : "Turn shortcuts on"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
