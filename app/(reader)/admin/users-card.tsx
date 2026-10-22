"use client"

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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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

import { deleteUser } from "../actions"

// Dates arrive formatted, so server and client render the same text.
export type UserRow = {
  id: string
  email: string
  joined: string
  feeds: number
  you: boolean
}

export function UsersCard({
  users,
  registration,
}: {
  users: UserRow[]
  registration: "open" | "closed"
}) {
  const [deleting, setDeleting] = useState<UserRow>()

  return (
    <Card>
      <CardHeader>
        <CardTitle>Users</CardTitle>
        <CardDescription>
          Registration is {registration}. Change REGISTRATION_ENABLED and
          redeploy to change it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              {/* A phone keeps Email and Delete, as Settings drops its dates. */}
              <TableHead className="hidden sm:table-cell">Joined</TableHead>
              <TableHead className="hidden sm:table-cell">Feeds</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">
                  {user.email}{" "}
                  {user.you && <Badge variant="secondary">you</Badge>}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {user.joined}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {user.feeds}
                </TableCell>
                <TableCell className="text-right">
                  {!user.you && (
                    <Button variant="ghost" onClick={() => setDeleting(user)}>
                      Delete
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      <DeleteUserDialog
        user={deleting}
        onOpenChange={(open) => !open && setDeleting(undefined)}
      />
    </Card>
  )
}

function DeleteUserDialog({
  user,
  onOpenChange,
}: {
  user?: UserRow
  onOpenChange: (open: boolean) => void
}) {
  async function remove() {
    if (!user) return
    onOpenChange(false)
    try {
      // An unknown user is a no-op, so one deleted already reads as done.
      await deleteUser(user.id)
      toast.success("User deleted")
    } catch {
      toast.error("Couldn’t delete the user. Try again.")
    }
  }

  return (
    <AlertDialog open={user !== undefined} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {user?.email}?</AlertDialogTitle>
          <AlertDialogDescription>
            Their subscriptions, read marks and API keys are deleted. Feeds
            others follow stay. This can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={remove}>Delete user</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
