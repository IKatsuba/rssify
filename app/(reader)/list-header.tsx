import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"

// Without a title (Feed not found, an error away from /) the header is just
// the trigger: a separator with nothing after it reads as a stray mark.
export function ListHeader({
  title,
  children,
}: {
  title?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger className="-ml-1" />
      {title && (
        <>
          <Separator
            orientation="vertical"
            className="mr-2 data-vertical:h-4 data-vertical:self-center"
          />
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
            {title}
          </h1>
        </>
      )}
      {children}
    </header>
  )
}
