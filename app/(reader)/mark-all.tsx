"use client"

import { useRouter } from "next/navigation"
import { useRef } from "react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { entryCount } from "@/lib/reader-view"

import { markAllRead } from "./actions"

// The Mark all as read confirm, shared by the list header and the entry page.
// unread is the scope's count on this render; asOf is when the list was read,
// so entries that arrive after the person looked stay unread. Opened with
// Shift+A it focuses the action, so Enter confirms (design §3).
export function MarkAllConfirm({
  feed,
  unread,
  asOf,
  open,
  byKey,
  onOpenChange,
}: {
  feed?: { id: string; title: string }
  unread: number
  asOf: Date
  open: boolean
  byKey: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const action = useRef<HTMLButtonElement>(null)

  async function markAll() {
    onOpenChange(false)
    try {
      const result = await markAllRead({ feedId: feed?.id, upTo: asOf })
      if (!result.ok) return router.push("/")
      toast.success(`Marked ${entryCount(result.marked)} as read`)
    } catch {
      toast.error("Couldn’t mark entries as read. Try again.")
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm" initialFocus={byKey ? action : true}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Mark {entryCount(unread)} as read?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Everything unread in {feed?.title ?? "All feeds"} up to now. Entries
            that arrive later stay unread.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction ref={action} onClick={markAll}>
            Mark as read
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
