import {
  CheckCheckIcon,
  CircleOffIcon,
  PlusIcon,
  RssIcon,
  TriangleAlertIcon,
} from "lucide-react"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { listEntries, ReaderError } from "@/lib/reader"
import {
  emptyState,
  entryHref,
  feedNotice,
  listHref,
  readListParams,
  type EmptyState,
  type ListFilter,
} from "@/lib/reader-view"
import { shortAgo } from "@/lib/relative-time"

import { subscriptionsOf } from "./data"
import { AddFeedButton } from "./add-feed"
import { EntryRows } from "./entry-rows"
import { ListActions } from "./list-actions"
import { ListHeader } from "./list-header"

type Feed = {
  id: string
  title: string
  url: string
  siteUrl: string | null
  status: "ok" | "failing" | "gone"
  lastError: string | null
  lastSuccessAt: Date | null
}

// One list for both / and /feeds/[feedId]: the scope is the feed, if any.
export async function EntryList({
  userId,
  feed,
  searchParams,
}: {
  userId: string
  feed?: Feed
  searchParams: Record<string, string | string[] | undefined>
}) {
  const { filter, cursor, before } = readListParams(searchParams)
  const path = feed ? `/feeds/${feed.id}` : "/"
  const scope = { feedId: feed?.id, unreadOnly: filter === "unread" }

  let list
  try {
    list = await listEntries(userId, { ...scope, cursor, before })
  } catch (e) {
    if (e instanceof ReaderError) {
      if (e.code === "invalid_cursor") redirect(listHref(path, { filter }))
      notFound()
    }
    throw e
  }

  const paged = list.prevCursor !== null
  // Only an empty first Unread page of a feed needs to know whether the
  // feed has anything at all.
  const feedHasEntries =
    feed && filter === "unread" && !paged && list.entries.length === 0
      ? (await listEntries(userId, { feedId: feed.id, limit: 1 })).entries
          .length > 0
      : undefined
  const subscriptions = await subscriptionsOf(userId)
  // The confirm's n: the scope's unread count, whatever the filter shows.
  const unread = subscriptions
    .filter((s) => !feed || s.feed.id === feed.id)
    .reduce((sum, s) => sum + s.unreadCount, 0)
  const empty = emptyState({
    rows: list.entries.length,
    paged,
    feedId: feed?.id,
    filter,
    subscriptions: subscriptions.length,
    feedHasEntries,
  })
  const notice = feed && feedNotice(feed)
  const now = new Date()

  return (
    <>
      <ListHeader title={feed?.title ?? "All feeds"}>
        <FilterLinks path={path} filter={filter} />
        <ListActions
          feed={
            feed && {
              id: feed.id,
              title: feed.title,
              url: feed.url,
              siteUrl: feed.siteUrl,
            }
          }
          unread={unread}
          asOf={list.asOf}
        />
      </ListHeader>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-2">
        {notice && (
          <Alert className="mx-2 mt-2 w-auto">
            {feed.status === "gone" ? <CircleOffIcon /> : <TriangleAlertIcon />}
            <AlertTitle>{notice.title}</AlertTitle>
            <AlertDescription>{notice.description}</AlertDescription>
          </Alert>
        )}
        {list.prevCursor && (
          <PageLink href={listHref(path, { filter, before: list.prevCursor })}>
            Newer entries
          </PageLink>
        )}
        {empty ? (
          <EmptyList state={empty} path={path} />
        ) : (
          <EntryRows
            // A new page or filter starts its own cursor.
            key={`${filter}:${cursor ?? ""}:${before ?? ""}`}
            list={listHref(path, { filter })}
            rows={list.entries.map((entry) => ({
              id: entry.id,
              href: entryHref(entry.id, { feedId: feed?.id, filter }),
              url: entry.url,
              read: entry.read,
              content: (
                <ItemContent className="min-w-0">
                  <p className="text-muted-foreground">
                    {!feed && `${entry.feedTitle ?? "(untitled)"} · `}
                    <time
                      dateTime={entry.sortAt.toISOString()}
                      title={entry.sortAt.toUTCString()}
                    >
                      {shortAgo(entry.sortAt, now)}
                    </time>
                  </p>
                  <ItemTitle
                    className={
                      entry.read
                        ? "font-normal text-muted-foreground"
                        : undefined
                    }
                  >
                    {entry.title}
                  </ItemTitle>
                  {entry.summary && (
                    <ItemDescription>{entry.summary}</ItemDescription>
                  )}
                </ItemContent>
              ),
            }))}
          />
        )}
        {list.nextCursor && (
          <PageLink href={listHref(path, { filter, cursor: list.nextCursor })}>
            Older entries
          </PageLink>
        )}
      </div>
    </>
  )
}

function FilterLinks({ path, filter }: { path: string; filter: ListFilter }) {
  return (
    <nav className="flex items-center gap-1">
      {(["unread", "all"] as const).map((value) => (
        <Button
          key={value}
          variant={filter === value ? "secondary" : "ghost"}
          nativeButton={false}
          aria-current={filter === value ? "page" : undefined}
          render={<Link href={listHref(path, { filter: value })} />}
        >
          {value === "unread" ? "Unread" : "All"}
        </Button>
      ))}
    </nav>
  )
}

function PageLink({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}) {
  return (
    <Button
      variant="outline"
      className="self-center"
      nativeButton={false}
      render={<Link href={href} />}
    >
      {children}
    </Button>
  )
}

const emptyText: Record<
  EmptyState,
  { title: string; description: string; icon?: React.ReactNode }
> = {
  no_feeds: {
    title: "No feeds yet",
    description:
      "Add a feed by its URL, or start with one of the built-in sources.",
    icon: <RssIcon />,
  },
  caught_up: {
    title: "All caught up",
    description:
      "Nothing unread. New entries show up here as your feeds update.",
    icon: <CheckCheckIcon />,
  },
  // All under ?filter=all with nothing stored: the caught-up words, and no
  // button, since it would link to this same list.
  nothing_at_all: {
    title: "All caught up",
    description:
      "Nothing unread. New entries show up here as your feeds update.",
    icon: <CheckCheckIcon />,
  },
  feed_no_unread: {
    title: "No unread entries",
    description: "Older entries from this feed are still under All.",
  },
  feed_no_entries: {
    title: "No entries yet",
    description:
      "This feed hasn’t published anything we could read. New entries show up here when it does.",
  },
}

function EmptyList({ state, path }: { state: EmptyState; path: string }) {
  const { title, description, icon } = emptyText[state]
  return (
    <Empty>
      <EmptyHeader>
        {icon && <EmptyMedia variant="icon">{icon}</EmptyMedia>}
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {state === "no_feeds" && (
        <EmptyContent>
          <AddFeedButton>
            <PlusIcon />
            Add feed
          </AddFeedButton>
        </EmptyContent>
      )}
      {state === "caught_up" && (
        <EmptyContent>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href={listHref(path, { filter: "all" })} />}
          >
            Show all entries
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}
