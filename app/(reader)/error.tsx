"use client"

import { CircleAlertIcon } from "lucide-react"
import { usePathname } from "next/navigation"
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

import { RETRY_EVENT } from "./app-sidebar"
import { ListHeader } from "./list-header"

// Pages whose title is known without a query; others get no title.
const titles: Record<string, string> = {
  "/": "All feeds",
  "/settings": "Settings",
}

export default function ReaderError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  const pathname = usePathname()
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <>
      <ListHeader title={titles[pathname]} />
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
          <Button
            variant="outline"
            onClick={() => {
              window.dispatchEvent(new Event(RETRY_EVENT))
              retry()
            }}
          >
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    </>
  )
}
