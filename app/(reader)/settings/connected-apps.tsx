"use client"

import { PlugIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

import { disconnectApp } from "../actions"

// Dates arrive formatted, so server and client render the same text.
export type AppRow = {
  clientId: string
  name: string
  website: string
  connected: string
}

export function ConnectedAppsCard({
  apps,
  mcpAddress,
}: {
  apps: AppRow[]
  mcpAddress: string
}) {
  const [disconnecting, setDisconnecting] = useState<AppRow>()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected apps</CardTitle>
        <CardDescription>Apps that use rssify through MCP.</CardDescription>
      </CardHeader>
      <CardContent>
        {apps.length === 0 ? (
          <Empty className="w-full border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PlugIcon />
              </EmptyMedia>
              <EmptyTitle>No connected apps</EmptyTitle>
              <EmptyDescription>
                Add rssify to an MCP client with the address {mcpAddress}.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Website</TableHead>
                {/* A phone keeps Name and Website; the date needs the width. */}
                <TableHead className="hidden sm:table-cell">
                  Connected
                </TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => (
                <TableRow key={app.clientId}>
                  <TableCell className="font-medium">{app.name}</TableCell>
                  <TableCell>{app.website}</TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {app.connected}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      onClick={() => setDisconnecting(app)}
                    >
                      Disconnect
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <DisconnectAppDialog
        app={disconnecting}
        onOpenChange={(open) => !open && setDisconnecting(undefined)}
      />
    </Card>
  )
}

function DisconnectAppDialog({
  app,
  onOpenChange,
}: {
  app?: AppRow
  onOpenChange: (open: boolean) => void
}) {
  async function disconnect() {
    if (!app) return
    onOpenChange(false)
    try {
      // not_found means it is gone already, which is what was asked.
      await disconnectApp(app.clientId)
      toast.success(`Disconnected ${app.name}`)
    } catch {
      toast.error("Couldn’t disconnect the app. Try again.")
    }
  }

  return (
    <AlertDialog open={app !== undefined} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {app?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            It loses access within an hour, and has to ask again to come back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={disconnect}>Disconnect</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
