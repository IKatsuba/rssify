"use client"

import { MailIcon, MailOpenIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useLayoutEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { intentQueue } from "@/lib/intent-queue"

import { markRead, markUnread } from "../../actions"
import { KeyHint, useKeys } from "../../keys"

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
    intentQueue({
      confirmed: initialRead,
      send: async (next: boolean) => {
        const result = await (next ? markRead : markUnread)(entryId)
        // Pruned or unsubscribed meanwhile: the page shows that state.
        if (!result.ok) router.refresh()
      },
      show: setRead,
      failed: (next) =>
        toast.error(
          next
            ? "Couldn’t mark it as read. Try again."
            : "Couldn’t mark it as unread. Try again."
        ),
    })
  )
  const opened = useRef(false)
  useKeys({ toggleRead: () => void push(!read) })

  // A layout effect, so the read state shows at once: a passive effect's
  // update waits behind the pending server action and would leave the
  // button saying "Mark as read" until the open call returns.
  useLayoutEffect(() => {
    // Development runs effects twice; once is enough.
    if (opened.current || initialRead) return
    opened.current = true
    push(true)
  }, [initialRead, push])

  return (
    <KeyHint
      label={read ? "Mark as unread" : "Mark as read"}
      keys={["M"]}
      render={<Button variant="outline" onClick={() => void push(!read)} />}
    >
      {read ? <MailOpenIcon /> : <MailIcon />}
      <span className="max-sm:sr-only">
        {read ? "Mark as unread" : "Mark as read"}
      </span>
    </KeyHint>
  )
}
