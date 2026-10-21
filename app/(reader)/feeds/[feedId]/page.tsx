import { notFound } from "next/navigation"

import { currentUser, subscriptionsOf } from "../../data"
import { EntryList } from "../../entry-list"

export default async function FeedPage({
  params,
  searchParams,
}: PageProps<"/feeds/[feedId]">) {
  const { userId } = await currentUser()
  const { feedId } = await params
  // The sidebar's own list, so the page needs no query of its own to find
  // the feed, and a feed the person doesn't follow is simply not there.
  const subscription = (await subscriptionsOf(userId)).find(
    (s) => s.feed.id === feedId
  )
  if (!subscription) notFound()
  const { feed } = subscription
  return (
    <EntryList
      userId={userId}
      feed={{ ...feed, title: feed.title ?? feed.url }}
      searchParams={await searchParams}
    />
  )
}
