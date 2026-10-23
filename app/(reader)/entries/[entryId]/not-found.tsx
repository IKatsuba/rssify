import { ArrowLeftIcon } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"

// Pruned past the newest 500, or never the reader's: the same words, so an
// id reveals nothing about other people's entries.
export default function EntryGone() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>This entry is no longer kept</EmptyTitle>
        <EmptyDescription>
          We keep the newest 500 entries of each feed, and this one is older.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href="/" />}
        >
          <ArrowLeftIcon />
          Back to All feeds
        </Button>
      </EmptyContent>
    </Empty>
  )
}
