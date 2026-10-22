"use client"

import { useSyncExternalStore } from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { onShortcutsChange, setShortcutsOn, shortcutsOn } from "@/lib/keys"

import { useShowShortcuts } from "../keys"

export function ShortcutsCard() {
  const showShortcuts = useShowShortcuts()
  const on = useSyncExternalStore(onShortcutsChange, shortcutsOn, () => true)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Keyboard shortcuts</CardTitle>
        <CardDescription>
          Single-letter keys like J and K. Turn them off if they get in your
          way.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={showShortcuts}>
          Show shortcuts
        </Button>
        <Button variant="outline" onClick={() => setShortcutsOn(!on)}>
          {on ? "Turn off" : "Turn on"}
        </Button>
      </CardContent>
    </Card>
  )
}
