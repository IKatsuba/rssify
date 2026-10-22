import { Skeleton } from "@/components/ui/skeleton"

import { ListHeader } from "./list-header"

// No text while loading: the title is a skeleton when it isn't known yet.
export function ListSkeleton({ title }: { title?: string }) {
  return (
    <>
      <ListHeader title={title ?? <Skeleton className="h-4 w-32" />} />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1 p-2">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2 px-3 py-2.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
    </>
  )
}
