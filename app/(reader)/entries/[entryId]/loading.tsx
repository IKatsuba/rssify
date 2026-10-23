import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <>
      <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mr-2 data-vertical:h-4 data-vertical:self-center"
        />
        <Skeleton className="h-4 w-24" />
      </header>
      <div className="mx-auto prose prose-sm flex w-full flex-col gap-3 px-4 py-8">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="mb-4 h-7 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </>
  )
}
