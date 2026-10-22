"use client"

import { MailIcon, MailOpenIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { intentQueue } from "@/lib/intent-queue"

import { markRead, markUnread } from "../../actions"

// Opening marks read here, after mount, never in the server render, so a
// prefetch cannot. The open call and the button share one queue, so a toggle
// pressed before the open call returns runs after it and wins.
export function ReadButton({
  entryId,
  read: initialRead,
}: {
  entryId: string
  read: boolean
}) {
  const router = useRouter()
  const [read, setRead] = useState(initialRead)
  const [push] = useState(() =>
    intentQueue(async (next: boolean, isLatest) => {
      try {
        const result = await (next ? markRead : markUnread)(entryId)
        // Pruned or unsubscribed meanwhile: the page shows that state.
        if (!result.ok) router.refresh()
      } catch {
        if (isLatest()) setRead(!next)
        toast.error(
          next
            ? "Couldn’t mark it as read. Try again."
            : "Couldn’t mark it as unread. Try again."
        )
      }
    })
  )
  const opened = useRef(false)

  function change(next: boolean) {
    setRead(next)
    push(next)
  }

  useEffect(() => {
    // Development runs effects twice; once is enough.
    if (opened.current || initialRead) return
    opened.current = true
    setRead(true)
    push(true)
  }, [initialRead, push])

  return (
    <Button variant="outline" onClick={() => change(!read)}>
      {read ? <MailOpenIcon /> : <MailIcon />}
      <span className="max-sm:sr-only">
        {read ? "Mark as unread" : "Mark as read"}
      </span>
    </Button>
  )
}
