"use client"

import {
  ChevronDownIcon,
  CircleOffIcon,
  InboxIcon,
  PlusIcon,
  RssIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { catchError, type ErrorInfo } from "next/error"
import { useTheme } from "next-themes"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect } from "react"

import { signOut } from "@/app/actions"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"

import { useAddFeed } from "./add-feed"
import { KeyHint, useShowShortcuts } from "./keys"

export type SidebarFeed = {
  id: string
  title: string
  status: "ok" | "failing" | "gone"
  unreadCount: number
}

const statusTooltip = {
  failing: "Not updating — open for details",
  gone: "Stopped — open for details",
}

// The frame is outside the Suspense boundary: below 768 px it turns into a
// sheet as soon as it hydrates, which a boundary still streaming inside it
// would otherwise see as a mismatch.
export function AppSidebar({
  email,
  children,
}: {
  email: string
  children: React.ReactNode
}) {
  const { setOpenMobile } = useSidebar()
  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={<Link href="/" onClick={() => setOpenMobile(false)} />}
            >
              <RssIcon />
              <span>rssify</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>{children}</SidebarContent>
      <SidebarFooter>
        <UserMenu email={email} />
      </SidebarFooter>
    </Sidebar>
  )
}

export function SidebarNav({
  feeds,
  totalUnread,
}: {
  feeds: SidebarFeed[]
  totalUnread: number
}) {
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()
  const addFeed = useAddFeed()
  // Below 768 px the sidebar is a sheet; choosing a place closes it.
  const close = () => setOpenMobile(false)

  return (
    <>
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === "/"}
              render={<Link href="/" onClick={close} />}
            >
              <InboxIcon />
              <span>All feeds</span>
            </SidebarMenuButton>
            {totalUnread > 0 && (
              <SidebarMenuBadge>{totalUnread}</SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Feeds</SidebarGroupLabel>
        <KeyHint
          label="Add feed"
          keys={["A"]}
          // Above, it would cover the All feeds count.
          side="right"
          render={
            <SidebarGroupAction
              onClick={() => {
                close()
                addFeed()
              }}
            />
          }
        >
          <PlusIcon />
          <span className="sr-only">Add feed</span>
        </KeyHint>
        <SidebarGroupContent>
          <SidebarMenu>
            {feeds.map((feed) => (
              <FeedItem
                key={feed.id}
                feed={feed}
                isActive={pathname === `/feeds/${feed.id}`}
                onNavigate={close}
              />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  )
}

function FeedItem({
  feed,
  isActive,
  onNavigate,
}: {
  feed: SidebarFeed
  isActive: boolean
  onNavigate: () => void
}) {
  const Icon =
    feed.status === "failing"
      ? TriangleAlertIcon
      : feed.status === "gone"
        ? CircleOffIcon
        : RssIcon
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        className={
          feed.status === "failing" ? "text-muted-foreground" : undefined
        }
        // The template shows menu tooltips only when collapsed; these say
        // why a feed looks different, so they show whenever hovered.
        tooltip={
          feed.status === "ok"
            ? undefined
            : { children: statusTooltip[feed.status], hidden: false }
        }
        render={<Link href={`/feeds/${feed.id}`} onClick={onNavigate} />}
      >
        <Icon />
        <span>{feed.title}</span>
      </SidebarMenuButton>
      {feed.unreadCount > 0 && (
        <SidebarMenuBadge>{feed.unreadCount}</SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  )
}

function UserMenu({ email }: { email: string }) {
  const { theme, setTheme } = useTheme()
  const showShortcuts = useShowShortcuts()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton />}>
            <span className="truncate">{email}</span>
            <ChevronDownIcon className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start">
            <DropdownMenuItem render={<Link href="/settings" />}>
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={showShortcuts}>
              Keyboard shortcuts
              <DropdownMenuShortcut>?</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Theme</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={theme ?? "system"}
                  onValueChange={(value) => setTheme(value)}
                >
                  <DropdownMenuRadioItem value="light">
                    Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    Dark
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    System
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => signOut()}>
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

// A failed feeds query keeps the frame and All feeds, without counts, so
// the page beside it can show its own error instead of Next's root one.
export const SidebarNavBoundary = catchError(function SidebarNavFallback(
  _props: object,
  { retry }: ErrorInfo
) {
  return <NavFallback retry={retry} />
})

// The page's Try again sends this, so the sidebar retries with it instead
// of staying empty until the next navigation.
export const RETRY_EVENT = "rssify:retry"

function NavFallback({ retry }: { retry: () => void }) {
  useEffect(() => {
    window.addEventListener(RETRY_EVENT, retry)
    return () => window.removeEventListener(RETRY_EVENT, retry)
  }, [retry])
  return <SidebarNav feeds={[]} totalUnread={0} />
}

// The feeds' Suspense fallback: All feeds without its count, and skeleton
// rows for the feeds until the counts arrive.
export function SidebarNavSkeleton() {
  return (
    <>
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link href="/" />}>
              <InboxIcon />
              <span>All feeds</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>Feeds</SidebarGroupLabel>
        <SidebarMenu>
          {Array.from({ length: 5 }, (_, i) => (
            <SidebarMenuItem
              key={i}
              className="flex h-8 items-center gap-2 px-2"
            >
              <Skeleton className="size-4 rounded-md" />
              <Skeleton className="h-4 flex-1" />
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>
    </>
  )
}
