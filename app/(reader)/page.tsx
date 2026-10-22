import { currentUser } from "./data"
import { EntryList } from "./entry-list"

export default async function AllFeedsPage({ searchParams }: PageProps<"/">) {
  const { userId } = await currentUser()
  return <EntryList userId={userId} searchParams={await searchParams} />
}
