import type { Metadata } from "next"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { requireAdmin } from "@/lib/actor"
import { listFeeds, listUsers } from "@/lib/admin"
import { longAgo } from "@/lib/relative-time"

import { ListHeader } from "../list-header"

import { type UserRow, UsersCard } from "./users-card"

export const metadata: Metadata = { title: "Admin · rssify" }

const day = new Intl.DateTimeFormat("en", { dateStyle: "medium" })

const STATUS = {
  failing: { label: "Failing", variant: "destructive" },
  gone: { label: "Gone", variant: "outline" },
  ok: { label: "OK", variant: "secondary" },
} as const

export default async function AdminPage() {
  const { userId } = await requireAdmin()
  const now = new Date()
  const [users, feeds] = await Promise.all([listUsers(), listFeeds()])
  const rows: UserRow[] = users.map((user) => ({
    id: user.id,
    email: user.email,
    joined: day.format(user.createdAt),
    feeds: user.feeds,
    you: user.id === userId,
  }))
  const registration =
    process.env.REGISTRATION_ENABLED === "true" ? "open" : "closed"

  return (
    <>
      <ListHeader title="Admin" />
      <div className="flex flex-col gap-6 p-4">
        <UsersCard users={rows} registration={registration} />
        <Card>
          <CardHeader>
            <CardTitle>Feeds</CardTitle>
            <CardDescription>
              Every feed anyone follows, failing first.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>URL</TableHead>
                  <TableHead>Subscribers</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Failures</TableHead>
                  <TableHead>Last error</TableHead>
                  <TableHead>Last success</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {feeds.map((feed) => (
                  <TableRow key={feed.id}>
                    <TableCell className="font-mono">{feed.url}</TableCell>
                    <TableCell>{feed.subscribers}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS[feed.status].variant}>
                        {STATUS[feed.status].label}
                      </Badge>
                    </TableCell>
                    <TableCell>{feed.failureCount}</TableCell>
                    <TableCell>{feed.lastError ?? "—"}</TableCell>
                    <TableCell>
                      {feed.lastSuccessAt
                        ? longAgo(feed.lastSuccessAt, now)
                        : "Never"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
