import type { Metadata } from "next"
import { cookies } from "next/headers"
import { Suspense } from "react"

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { normaliseUrl } from "@/lib/reader"
import { builtinSources } from "@/sources/builtin"

import { AddFeedProvider, type BuiltinChoice } from "./add-feed"

import {
  AppSidebar,
  SidebarNav,
  SidebarNavBoundary,
  SidebarNavSkeleton,
} from "./app-sidebar"
import { currentUser, subscriptionsOf, totalUnread } from "./data"
import { KeysProvider } from "./keys"

// The add-feed action runs under this layout and fetches the feed.
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
    <AddFeedProvider sources={builtinChoices(userId)}>
      <KeysProvider>
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
      </KeysProvider>
    </AddFeedProvider>
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

// Streamed to the dialog, so the frame does not wait on the subscriptions.
// A failed read lists every source as not yet followed; subscribing to one
// already followed only says so.
async function builtinChoices(userId: string): Promise<BuiltinChoice[]> {
  const followed = new Set(
    await subscriptionsOf(userId).then(
      (subscriptions) => subscriptions.map((s) => s.feed.url),
      () => []
    )
  )
  return builtinSources.map(({ id, title, url, note }) => ({
    id,
    title,
    url,
    note,
    subscribed: followed.has(normaliseUrl(url) ?? url),
  }))
}
