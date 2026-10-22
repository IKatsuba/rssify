"use client"

import { CopyIcon, KeyRoundIcon, PlusIcon } from "lucide-react"
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

import { createApiKey, revokeApiKey } from "../actions"

// Dates arrive formatted, so server and client render the same text.
export type KeyRow = {
  id: string
  name: string
  start: string
  created: string
  lastUsed: string
}

export function ApiKeysCard({ keys }: { keys: KeyRow[] }) {
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ name: string; key: string }>()
  const [revoking, setRevoking] = useState<KeyRow>()

  const createButton = (
    <Button onClick={() => setCreating(true)}>
      <PlusIcon data-icon="inline-start" />
      Create API key
    </Button>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>
          A key lets a feed reader or a script read your entries and mark them
          read. Treat it like a password.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-4">
        {keys.length === 0 ? (
          <Empty className="w-full border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRoundIcon />
              </EmptyMedia>
              <EmptyTitle>No API keys</EmptyTitle>
              <EmptyDescription>
                Create one when a reader app or a script needs to reach your
                feeds.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>{createButton}</EmptyContent>
          </Empty>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  {/* A phone keeps Name and Key; the dates need the width. */}
                  <TableHead className="hidden sm:table-cell">
                    Created
                  </TableHead>
                  <TableHead className="hidden sm:table-cell">
                    Last used
                  </TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell className="font-mono">{key.start}…</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {key.created}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {key.lastUsed}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" onClick={() => setRevoking(key)}>
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {createButton}
          </>
        )}
      </CardContent>
      <CreateKeyDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(key) => {
          setCreating(false)
          setCreated(key)
        }}
      />
      <CreatedKeyDialog
        created={created}
        onDone={() => setCreated(undefined)}
      />
      <RevokeKeyDialog
        apiKey={revoking}
        onOpenChange={(open) => !open && setRevoking(undefined)}
      />
    </Card>
  )
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (created: { name: string; key: string }) => void
}) {
  const [name, setName] = useState("")
  const [pending, setPending] = useState(false)

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    try {
      const { key } = await createApiKey(name)
      setName("")
      onCreated({ name: name.trim(), key })
    } catch {
      toast.error("Couldn’t create the key. Try again.")
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={create} className="contents">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Name it after where you’ll use it, so you know which one to revoke
              later.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="api-key-name">Name</FieldLabel>
            <Input
              id="api-key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="NetNewsWire on my laptop"
              maxLength={64}
              required
              autoComplete="off"
            />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={pending || !name.trim()}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// The whole key exists only here; the field shows its start and the copy
// button carries the rest, so it is never left on screen (design §2.5).
function CreatedKeyDialog({
  created,
  onDone,
}: {
  created?: { name: string; key: string }
  onDone: () => void
}) {
  async function copy() {
    if (!created) return
    await navigator.clipboard.writeText(created.key)
    toast.success("Key copied")
  }

  return (
    <Dialog
      open={created !== undefined}
      // Only Done closes it, so the key is not lost to a stray click.
      disablePointerDismissal
      onOpenChange={(open) => !open && onDone()}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Copy your new key</DialogTitle>
          <DialogDescription>
            This is the only time you’ll see it. If you lose it, revoke it and
            make another.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="api-key-created">{created?.name}</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="api-key-created"
              readOnly
              className="font-mono"
              value={
                created ? `${created.key.slice(0, 8)}${"·".repeat(28)}` : ""
              }
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label="Copy key"
                onClick={copy}
              >
                <CopyIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription>Send it as the x-api-key header.</FieldDescription>
        </Field>
        <DialogFooter>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RevokeKeyDialog({
  apiKey,
  onOpenChange,
}: {
  apiKey?: KeyRow
  onOpenChange: (open: boolean) => void
}) {
  async function revoke() {
    if (!apiKey) return
    onOpenChange(false)
    try {
      // not_found means it is gone already, which is what was asked.
      await revokeApiKey(apiKey.id)
      toast.success("Key revoked")
    } catch {
      toast.error("Couldn’t revoke the key. Try again.")
    }
  }

  return (
    <AlertDialog open={apiKey !== undefined} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke “{apiKey?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Anything using this key stops working at once. This can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={revoke}>Revoke key</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
