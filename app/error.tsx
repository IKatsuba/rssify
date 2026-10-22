"use client"

import { CircleAlertIcon } from "lucide-react"
import { useEffect } from "react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

// Catches what (reader)/error.tsx cannot: a failure in the reader layout
// itself, such as the session lookup, so an outage still reads as ours.
export default function RootError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <main className="flex min-h-svh">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleAlertIcon />
          </EmptyMedia>
          <EmptyTitle>Couldn’t load your feeds</EmptyTitle>
          <EmptyDescription>
            Something went wrong on our side. Try again in a moment.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={() => retry()}>
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  )
}
