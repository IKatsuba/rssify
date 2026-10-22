"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Item, ItemGroup } from "@/components/ui/item"
import { intentQueue } from "@/lib/intent-queue"
import { ROW_ATTRIBUTE } from "@/lib/keys"
import { clampCursor, moveCursor, restoreCursor } from "@/lib/list-cursor"

import { markRead, markUnread } from "./actions"
import { useKeys } from "./keys"
import { clearReturn, readReturn, writeReturn } from "./return-point"

export type Row = {
  id: string
  href: string
  url: string | null
  read: boolean
  content: React.ReactNode
}

// The list's rows and its keyboard cursor (design §3). The cursor is client
// state: it starts on the first row, or on the entry the person came back
// from, and stays at its index when m drops a row from an Unread list.
// list is the scope's first page, href the page shown.
export function EntryRows({
  list,
  href,
  rows,
}: {
  list: string
  href: string
  rows: Row[]
}) {
  const router = useRouter()
  const [cursor, setCursor] = useState(0)
  const at = clampCursor(cursor, rows.length)
  const row = rows[at]
  const moved = useRef(false)
  // One queue per row, so repeated m on a row sends in order and the last
  // press wins, as on the entry page. last is what the person asked for.
  const queues = useRef(
    new Map<string, { push: (read: boolean) => void; last: boolean }>()
  )

  useLayoutEffect(() => {
    const index = restoreCursor(
      readReturn(),
      href,
      rows.map((r) => r.id)
    )
    if (index === null) return
    clearReturn()
    moved.current = true
    // Restoring from storage after hydration; the server cannot know it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCursor(index)
    // Only on arrival: later renders keep the person's own cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [href])

  useEffect(() => {
    if (moved.current) {
      document
        .querySelector("[data-cursor]")
        ?.scrollIntoView({ block: "nearest" })
    }
    moved.current = false
  }, [at])

  function open(index: number) {
    writeReturn({ list, href, id: rows[index].id, ids: rows.map((r) => r.id) })
  }

  function move(step: number) {
    moved.current = true
    setCursor(moveCursor(at, step, rows.length))
  }

  function toggleRead({ id, read }: Row) {
    let queue = queues.current.get(id)
    if (!queue) {
      const entry = {
        last: read,
        push: intentQueue({
          confirmed: read,
          send: async (next: boolean) => {
            await (next ? markRead : markUnread)(id)
          },
          show: (state: boolean) => (entry.last = state),
          failed: (next) =>
            toast.error(
              next
                ? "Couldn’t mark it as read. Try again."
                : "Couldn’t mark it as unread. Try again."
            ),
        }),
      }
      queue = entry
      queues.current.set(id, entry)
    }
    queue.push(!queue.last)
  }

  useKeys(
    row
      ? {
          next: () => move(1),
          previous: () => move(-1),
          open: () => {
            open(at)
            router.push(row.href)
          },
          toggleRead: () => toggleRead(row),
          original: () =>
            row.url !== null &&
            void window.open(row.url, "_blank", "noopener,noreferrer"),
        }
      : {},
    "list"
  )

  return (
    <ItemGroup className="gap-1">
      {rows.map((r, index) => (
        <Item
          key={r.id}
          role="listitem"
          {...{ [ROW_ATTRIBUTE]: "" }}
          data-cursor={index === at || undefined}
          // Hover is lighter than the cursor, so the row the keys act on
          // stays clear with the pointer resting on another.
          className="data-cursor:bg-muted [a]:hover:bg-muted/50 data-cursor:[a]:hover:bg-muted"
          onFocus={() => setCursor(index)}
          onClick={() => open(index)}
          render={
            // Opening an entry will mark it read, so never prefetch.
            <Link href={r.href} prefetch={false} />
          }
        >
          {r.content}
        </Item>
      ))}
    </ItemGroup>
  )
}
