import type { Metadata } from "next"
import { headers } from "next/headers"

import { signOut } from "@/app/actions"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { listApiKeys } from "@/lib/api-keys"
import { MCP_RESOURCE } from "@/lib/auth"
import { listConnectedApps } from "@/lib/mcp-clients"
import { longAgo } from "@/lib/relative-time"

import { currentUser } from "../data"
import { ListHeader } from "../list-header"

import { ApiKeysCard, type KeyRow } from "./api-keys"
import { type AppRow, ConnectedAppsCard } from "./connected-apps"
import { ShortcutsCard } from "./shortcuts-card"

export const metadata: Metadata = { title: "Settings · rssify" }

const day = new Intl.DateTimeFormat("en", { dateStyle: "medium" })

export default async function SettingsPage() {
  const { userId, email } = await currentUser()
  const now = new Date()
  const keys: KeyRow[] = (await listApiKeys(await headers())).map((key) => ({
    id: key.id,
    name: key.name ?? "",
    start: key.start ?? "",
    created: day.format(key.createdAt),
    lastUsed: key.lastRequest ? longAgo(key.lastRequest, now) : "Never",
  }))
  const apps: AppRow[] = (await listConnectedApps(userId)).map((app) => ({
    clientId: app.clientId,
    name: app.name,
    website: app.host ?? "",
    connected: day.format(app.createdAt),
  }))

  return (
    <>
      <ListHeader title="Settings" />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>Signed in with Vercel as {email}.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={signOut}>
              <Button type="submit" variant="outline">
                Sign out
              </Button>
            </form>
          </CardContent>
        </Card>
        <ApiKeysCard keys={keys} />
        <ConnectedAppsCard apps={apps} mcpAddress={MCP_RESOURCE} />
        <ShortcutsCard />
      </div>
    </>
  )
}
