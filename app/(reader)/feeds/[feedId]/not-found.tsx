import Link from "next/link"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"

import { ListHeader } from "../../list-header"

export default function FeedNotFound() {
  return (
    <>
      <ListHeader />
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Feed not found</EmptyTitle>
          <EmptyDescription>
            You aren’t subscribed to this feed.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/" />}
          >
            Back to All feeds
          </Button>
        </EmptyContent>
      </Empty>
    </>
  )
}
