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

import { ListHeader } from "./list-header"

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
      <ListHeader title={pathname === "/" ? "All feeds" : undefined} />
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
    </>
  )
}
