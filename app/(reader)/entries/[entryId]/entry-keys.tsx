"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

import { useKeys } from "../../keys"
import { MarkAllConfirm } from "../../mark-all"
import { useBackHref, useFollowEntry } from "../../return-point"

// The entry page's keys (design §3); m lives on ReadButton, which owns the
// entry's read queue.
export function EntryKeys({
  entryId,
  back,
  next,
  previous,
  url,
  feed,
  unread,
  asOf,
}: {
  entryId: string
  back: string
  next: string | null
  previous: string | null
  url: string | null
  feed?: { id: string; title: string }
  unread: number
  asOf: Date
}) {
  const router = useRouter()
  const [confirm, setConfirm] = useState(false)
  useFollowEntry(back, entryId)
  const backTo = useBackHref(back)
  useKeys(
    {
      next: () => next !== null && router.push(next),
      previous: () => previous !== null && router.push(previous),
      back: () => router.push(backTo),
      original: () =>
        url !== null && void window.open(url, "_blank", "noopener,noreferrer"),
      markAll: () => unread > 0 && setConfirm(true),
    },
    "entry"
  )
  return (
    <MarkAllConfirm
      feed={feed}
      unread={unread}
      asOf={asOf}
      open={confirm}
      byKey
      onOpenChange={setConfirm}
    />
  )
}
