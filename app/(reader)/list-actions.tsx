"use client"

import { CheckCheckIcon, EllipsisIcon, ExternalLinkIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"
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
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { entryCount } from "@/lib/reader-view"

import { markAllRead, unsubscribe } from "./actions"

type ListFeed = {
  id: string
  title: string
  url: string
  siteUrl: string | null
}

// The list header's actions: Mark all as read for the list's scope and, on a
// feed page, the feed's … menu. unread is the scope's count on this render;
// asOf is when the list was read, so entries that arrive after the person
// looked stay unread.
export function ListActions({
  feed,
  unread,
  asOf,
}: {
  feed?: ListFeed
  unread: number
  asOf: Date
}) {
  const router = useRouter()
  const [confirm, setConfirm] = useState<"mark" | "unsubscribe" | null>(null)
  const close = (open: boolean) => !open && setConfirm(null)

  async function markAll() {
    setConfirm(null)
    try {
      const result = await markAllRead({ feedId: feed?.id, upTo: asOf })
      if (!result.ok) return router.push("/")
      toast.success(`Marked ${entryCount(result.marked)} as read`)
    } catch {
      toast.error("Couldn’t mark entries as read. Try again.")
    }
  }

  async function leave(feed: ListFeed) {
    setConfirm(null)
    try {
      // Already gone (another tab) ends in the same place: not followed.
      await unsubscribe(feed.id)
      router.push("/")
      toast.success(`Unsubscribed from ${feed.title}`)
    } catch {
      toast.error("Couldn’t unsubscribe. Try again.")
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        disabled={unread === 0}
        onClick={() => setConfirm("mark")}
      >
        <CheckCheckIcon />
        <span className="sr-only">Mark all as read</span>
      </Button>
      {feed && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
            <EllipsisIcon />
            <span className="sr-only">Feed actions</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {feed.siteUrl && (
              <DropdownMenuItem
                render={
                  <a
                    href={feed.siteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                Open website
                <ExternalLinkIcon className="ml-auto" />
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => navigator.clipboard.writeText(feed.url)}
            >
              Copy feed URL
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={unread === 0}
              onClick={() => setConfirm("mark")}
            >
              Mark all as read
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setConfirm("unsubscribe")}
            >
              Unsubscribe…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <AlertDialog open={confirm === "mark"} onOpenChange={close}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Mark {entryCount(unread)} as read?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Everything unread in {feed?.title ?? "All feeds"} up to now.
              Entries that arrive later stay unread.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={markAll}>
              Mark as read
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {feed && (
        <AlertDialog open={confirm === "unsubscribe"} onOpenChange={close}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>
                Unsubscribe from {feed.title}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                It leaves your sidebar, and its entries leave your lists. You
                can add it again later.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => leave(feed)}>
                Unsubscribe
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  )
}
