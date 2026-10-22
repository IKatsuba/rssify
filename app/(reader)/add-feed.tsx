"use client"

import { RssIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { createContext, Suspense, use, useState } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { addFeedError } from "@/lib/add-feed-errors"

import { subscribe } from "./actions"

export type BuiltinChoice = {
  id: string
  title: string
  url: string
  note: string
  subscribed: boolean
}

const AddFeedContext = createContext<() => void>(() => {})

// One dialog for the reader; the sidebar's + and the No feeds state open it.
export function AddFeedProvider({
  sources,
  children,
}: {
  sources: Promise<BuiltinChoice[]>
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  // A new key each time it opens, so it always starts on an empty field.
  const [session, setSession] = useState(0)
  const show = () => {
    setSession((n) => n + 1)
    setOpen(true)
  }
  return (
    <AddFeedContext value={show}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <Suspense fallback={<Spinner className="mx-auto" />}>
            <AddFeedForm
              key={session}
              sources={sources}
              done={() => setOpen(false)}
            />
          </Suspense>
        </DialogContent>
      </Dialog>
    </AddFeedContext>
  )
}

export function useAddFeed() {
  return use(AddFeedContext)
}

export function AddFeedButton(props: React.ComponentProps<typeof Button>) {
  const open = useAddFeed()
  return <Button {...props} onClick={open} />
}

type Target = { url: string } | { source: string }

function AddFeedForm({
  sources: sourcesPromise,
  done,
}: {
  sources: Promise<BuiltinChoice[]>
  done: () => void
}) {
  const sources = use(sourcesPromise)
  const router = useRouter()
  const [url, setUrl] = useState("")
  // A source's failure shows under that source, not under the URL field.
  const [error, setError] = useState<{
    message: string
    source?: string
  } | null>(null)
  // What is being added, so only that button shows "Adding…".
  const [adding, setAdding] = useState<Target | null>(null)
  const [choices, setChoices] = useState<string[] | null>(null)

  async function add(target: Target) {
    setAdding(target)
    setError(null)
    // The sentence names the host the person typed, or the source's own.
    const source = "source" in target ? target.source : undefined
    const typed =
      "url" in target
        ? target.url
        : (sources.find((s) => s.id === target.source)?.url ?? "")
    const fail = (code: string) =>
      setError({ message: addFeedError(code, typed), source })
    try {
      const result = await subscribe(target)
      if (result.ok) {
        done()
        router.push(`/feeds/${result.feedId}`)
        toast.success(
          result.existed
            ? `You already follow ${result.title}.`
            : `Subscribed to ${result.title}.`
        )
        return
      }
      if (result.code === "multiple" && "choices" in result && result.choices) {
        setChoices(result.choices)
        fail("multiple")
      } else {
        setChoices(null)
        fail(result.code)
      }
    } catch {
      setChoices(null)
      fail("")
    }
    setAdding(null)
  }

  const busy = adding !== null
  const urlError = error && !error.source ? error.message : null
  const header = (
    <DialogHeader>
      <DialogTitle>Add a feed</DialogTitle>
      <DialogDescription>
        Paste a feed URL or a website’s address. We’ll find its feed.
      </DialogDescription>
    </DialogHeader>
  )

  if (choices) {
    return (
      <>
        {header}
        <p className="text-muted-foreground">{error?.message}</p>
        <ItemGroup className="gap-2">
          {choices.map((choice) => (
            <Item key={choice} variant="outline">
              <ItemContent className="min-w-0">
                <ItemDescription className="break-all">
                  {choice}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <AddButton
                  variant="outline"
                  busy={busy}
                  adding={
                    adding !== null && "url" in adding && adding.url === choice
                  }
                  onClick={() => add({ url: choice })}
                >
                  Subscribe
                </AddButton>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setChoices(null)
              setError(null)
            }}
          >
            Back
          </Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <>
      {header}
      <FieldGroup>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            add({ url })
          }}
        >
          <Field data-invalid={urlError ? true : undefined}>
            <FieldLabel htmlFor="add-feed-url">URL</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="add-feed-url"
                name="url"
                type="text"
                inputMode="url"
                autoComplete="url"
                placeholder="https://example.com"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                disabled={busy}
                aria-invalid={urlError ? true : undefined}
              />
              <AddButton
                type="submit"
                busy={busy || url.trim() === ""}
                adding={adding !== null && "url" in adding}
              >
                Add
              </AddButton>
            </div>
            <FieldError>{urlError}</FieldError>
          </Field>
        </form>
        <FieldSeparator>or pick a built-in source</FieldSeparator>
        {/* The list outgrows a phone's height; only it scrolls, so the URL field stays in view. */}
        <ItemGroup className="-mx-4 max-h-[50vh] gap-2 overflow-y-auto px-4">
          {sources.map((source) => (
            <div key={source.id} className="flex flex-col gap-1">
              <Item variant="outline">
                <ItemMedia variant="icon">
                  <RssIcon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{source.title}</ItemTitle>
                  <ItemDescription>{source.note}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  {source.subscribed ? (
                    <Badge variant="secondary">Subscribed</Badge>
                  ) : (
                    <AddButton
                      variant="outline"
                      busy={busy}
                      adding={
                        adding !== null &&
                        "source" in adding &&
                        adding.source === source.id
                      }
                      onClick={() => add({ source: source.id })}
                    >
                      Subscribe
                    </AddButton>
                  )}
                </ItemActions>
              </Item>
              {error?.source === source.id && (
                <FieldError>{error.message}</FieldError>
              )}
            </div>
          ))}
        </ItemGroup>
      </FieldGroup>
    </>
  )
}

// Disabled while anything is being added; the one being added says so.
function AddButton({
  busy,
  adding,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { busy: boolean; adding: boolean }) {
  return (
    <Button {...props} disabled={busy}>
      {adding ? (
        <>
          {/* The text says it; a second "Loading" would muddle the name. */}
          <Spinner aria-hidden />
          Adding…
        </>
      ) : (
        children
      )}
    </Button>
  )
}
