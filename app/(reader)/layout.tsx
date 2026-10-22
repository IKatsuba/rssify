import type { Metadata } from "next"
import { cookies } from "next/headers"
import { Suspense } from "react"

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"

import {
  AppSidebar,
  SidebarNav,
  SidebarNavBoundary,
  SidebarNavSkeleton,
} from "./app-sidebar"
import { currentUser, subscriptionsOf, totalUnread } from "./data"

// The add-feed actions (a later unit) run under this layout and fetch.
export const maxDuration = 60

export async function generateMetadata(): Promise<Metadata> {
  const { userId } = await currentUser()
  // A failed count leaves the plain title; the page shows the error.
  const unread = await totalUnread(userId).catch(() => 0)
  return { title: unread > 0 ? `${unread} unread · rssify` : "rssify" }
}

export default async function ReaderLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { userId, email } = await currentUser()
  // The template's own cookie, so a collapsed sidebar stays collapsed.
  const defaultOpen = (await cookies()).get("sidebar_state")?.value !== "false"

  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={defaultOpen}>
        <AppSidebar email={email}>
          <SidebarNavBoundary>
            <Suspense fallback={<SidebarNavSkeleton />}>
              <ReaderNav userId={userId} />
            </Suspense>
          </SidebarNavBoundary>
        </AppSidebar>
        {/* min-w-0: a long <pre> would otherwise widen the column past a phone. */}
        <SidebarInset className="min-w-0">{children}</SidebarInset>
      </SidebarProvider>
      <Toaster />
    </TooltipProvider>
  )
}

async function ReaderNav({ userId }: { userId: string }) {
  const subscriptions = await subscriptionsOf(userId)
  return (
    <SidebarNav
      totalUnread={await totalUnread(userId)}
      feeds={subscriptions.map(({ feed, unreadCount }) => ({
        id: feed.id,
        title: feed.title ?? feed.url,
        status: feed.status,
        unreadCount,
      }))}
    />
  )
}
