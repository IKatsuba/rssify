"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Item, ItemGroup } from "@/components/ui/item"
import { intentQueue } from "@/lib/intent-queue"
import { ROW_ATTRIBUTE } from "@/lib/keys"

import { markRead, markUnread } from "./actions"
import { useKeys } from "./keys"

export type Row = {
  id: string
  href: string
  url: string | null
  read: boolean
  content: React.ReactNode
}

// Where Back should put the cursor: the list it belongs to, the entry last
// shown and the row index it was opened from, for when that row has left an
// Unread list by the time the person comes back.
const RETURN_KEY = "rssify:cursor"
type Return = { list: string; id: string; index: number }

function readReturn(): Return | null {
  try {
    return JSON.parse(sessionStorage.getItem(RETURN_KEY) ?? "null")
  } catch {
    return null
  }
}

function writeReturn(value: Return) {
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify(value))
  } catch {
    // Without storage Back starts on the first row.
  }
}

function clearReturn() {
  try {
    sessionStorage.removeItem(RETURN_KEY)
  } catch {
    // Nothing stored to clear.
  }
}

// The entry page keeps the return point on the entry it shows, so Back after
// j/k lands on the last entry read, not the one first opened.
export function useReturnTo(list: string, id: string) {
  useEffect(() => {
    const saved = readReturn()
    if (saved?.list === list) writeReturn({ ...saved, id })
  }, [list, id])
}

// The list's rows and its keyboard cursor (design §3). The cursor is client
// state: it starts on the first row, or on the entry the person came back
// from, and stays at its index when m drops a row from an Unread list.
export function EntryRows({ list, rows }: { list: string; rows: Row[] }) {
  const router = useRouter()
  const [cursor, setCursor] = useState(0)
  const at = Math.min(cursor, rows.length - 1)
  const row = rows[at]
  const moved = useRef(false)
  // One queue per row, so repeated m on a row sends in order and the last
  // press wins, as on the entry page. last is what the person asked for.
  const queues = useRef(
    new Map<string, { push: (read: boolean) => void; last: boolean }>()
  )

  useLayoutEffect(() => {
    const saved = readReturn()
    if (saved?.list !== list) return
    clearReturn()
    const index = rows.findIndex((r) => r.id === saved.id)
    // Restoring from storage after hydration; the server cannot know it.
    moved.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCursor(index >= 0 ? index : saved.index)
    // Only on arrival: later renders keep the person's own cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list])

  useEffect(() => {
    if (moved.current) {
      document
        .querySelector("[data-cursor]")
        ?.scrollIntoView({ block: "nearest" })
    }
    moved.current = false
  }, [at])

  function open(index: number) {
    writeReturn({ list, id: rows[index].id, index })
  }

  function move(step: number) {
    moved.current = true
    setCursor(Math.max(0, Math.min(at + step, rows.length - 1)))
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
          refresh: () => router.refresh(),
        }
      : { refresh: () => router.refresh() },
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
          className="data-cursor:bg-muted"
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
