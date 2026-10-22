import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ExternalLinkIcon,
} from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { cache } from "react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { getEntry, getNeighbours, ReaderError } from "@/lib/reader"
import {
  entryHref,
  listHref,
  readEntryParams,
  siteName,
} from "@/lib/reader-view"

import { currentUser, subscriptionsOf } from "../../data"
import { BackButton } from "./back-button"
import { EntryKeys } from "./entry-keys"
import { ReadButton } from "./read-button"

// Rendering never marks read; ReadButton does, from the client after mount.
const entryOf = cache(async (userId: string, entryId: string) => {
  try {
    return await getEntry(userId, entryId)
  } catch (e) {
    if (e instanceof ReaderError) return null
    throw e
  }
})

export async function generateMetadata({
  params,
}: PageProps<"/entries/[entryId]">): Promise<Metadata> {
  const { userId } = await currentUser()
  const entry = await entryOf(userId, (await params).entryId)
  return entry ? { title: `${entry.title} · rssify` } : {}
}

const dateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeZone: "UTC",
})

export default async function EntryPage({
  params,
  searchParams,
}: PageProps<"/entries/[entryId]">) {
  const { userId } = await currentUser()
  const { entryId } = await params
  const entry = await entryOf(userId, entryId)
  if (!entry) notFound()

  // The list it came from: a feed only when it is followed and holds this
  // entry, else All feeds, so a stale or edited ?feed= still reads well.
  const query = readEntryParams(await searchParams)
  const subscriptions = await subscriptionsOf(userId)
  const feed = subscriptions.find(
    (s) => s.feed.id === query.feedId && s.feed.id === entry.feedId
  )?.feed
  // Shift+A here marks its list, so the confirm needs that scope's count.
  const unread = subscriptions
    .filter((s) => !feed || s.feed.id === feed.id)
    .reduce((sum, s) => sum + s.unreadCount, 0)
  const backHref = listHref(feed ? `/feeds/${feed.id}` : "/", {
    filter: query.filter,
  })
  const scope = { feedId: feed?.id, filter: query.filter }
  const { previousId, nextId } = await getNeighbours(userId, entry.id, {
    feedId: feed?.id,
    unreadOnly: query.filter === "unread",
  })
  const listName = feed ? (feed.title ?? feed.url) : "All feeds"
  const site = entry.url && siteName(entry.url)
  const meta = [
    entry.feedTitle,
    dateFormat.format(entry.publishedAt ?? entry.sortAt),
    entry.author,
  ].filter(Boolean)

  return (
    <>
      <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mr-2 data-vertical:h-4 data-vertical:self-center"
        />
        <BackButton list={backHref}>
          <ArrowLeftIcon />
          <span className="truncate max-sm:sr-only">{listName}</span>
        </BackButton>
        <nav className="ml-auto flex items-center gap-1">
          <StepLink
            href={previousId && entryHref(previousId, scope)}
            label="Previous entry"
          >
            <ChevronUpIcon />
          </StepLink>
          <StepLink
            href={nextId && entryHref(nextId, scope)}
            label="Next entry"
          >
            <ChevronDownIcon />
          </StepLink>
        </nav>
        <Separator
          orientation="vertical"
          className="mx-1 data-vertical:h-4 data-vertical:self-center"
        />
        <ReadButton key={entry.id} entryId={entry.id} read={entry.read} />
        {entry.url ? (
          <Button
            variant="outline"
            nativeButton={false}
            render={
              <a href={entry.url} target="_blank" rel="noopener noreferrer" />
            }
          >
            <ExternalLinkIcon />
            <span className="max-sm:sr-only">Open original</span>
          </Button>
        ) : (
          <Button variant="outline" disabled>
            <ExternalLinkIcon />
            <span className="max-sm:sr-only">Open original</span>
          </Button>
        )}
        <EntryKeys
          entryId={entry.id}
          back={backHref}
          next={nextId && entryHref(nextId, scope)}
          previous={previousId && entryHref(previousId, scope)}
          url={entry.url}
          feed={feed && { id: feed.id, title: listName }}
          unread={unread}
          asOf={new Date()}
        />
      </header>
      <article className="mx-auto prose prose-sm w-full min-w-0 px-4 py-8 dark:prose-invert prose-code:before:content-none prose-code:after:content-none">
        <p className="not-prose text-xs text-muted-foreground">
          {meta.join(" · ")}
        </p>
        <h1 className="not-prose mt-2 text-2xl font-semibold tracking-tight text-foreground">
          {entry.title}
        </h1>
        <div className="mt-6">
          {entry.contentHtml ? (
            // Sanitised at ingest (lib/ingest/sanitize.ts) before storage.
            <div dangerouslySetInnerHTML={{ __html: entry.contentHtml }} />
          ) : entry.summary ? (
            <p>{entry.summary}</p>
          ) : (
            // Our state line, not the entry's text, so it reads as muted.
            <p className="text-muted-foreground">This entry has no text</p>
          )}
        </div>
        {!entry.contentHtml && entry.url && (
          <Button
            variant="outline"
            className="not-prose mt-6"
            nativeButton={false}
            render={
              <a href={entry.url} target="_blank" rel="noopener noreferrer" />
            }
          >
            Read on {site}
          </Button>
        )}
      </article>
    </>
  )
}

function StepLink({
  href,
  label,
  children,
}: {
  href: string | null
  label: string
  children: React.ReactNode
}) {
  // No neighbour that way: a disabled button, not a dead link.
  if (!href) {
    return (
      <Button variant="ghost" size="icon" disabled>
        {children}
        <span className="sr-only">{label}</span>
      </Button>
    )
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      nativeButton={false}
      render={<Link href={href} prefetch={false} />}
    >
      {children}
      <span className="sr-only">{label}</span>
    </Button>
  )
}
