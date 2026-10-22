import type { Metadata } from "next"
import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"
import { cache } from "react"

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Toaster } from "@/components/ui/sonner"
import { loadConsent, oauthQueryOf } from "@/lib/consent"

import { ConsentButtons } from "./consent-buttons"

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

// Once per request, for both the title and the page.
const consentFor = cache(async (query: string) =>
  loadConsent(query, await headers())
)

async function load({ searchParams }: Props) {
  return consentFor(oauthQueryOf(await searchParams))
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const request = await load(props)
  if (request.kind !== "ask") return {}
  return { title: `Allow ${request.name} · rssify` }
}

// The provider sends the browser here with a signed query when the user has
// no consent covering the request; no client bypasses it, and a disconnect
// in Settings brings it back. Every requested scope is shown before it can
// be granted.
export default async function ConsentPage(props: Props) {
  const request = await load(props)
  if (request.kind === "not_found") notFound()
  if (request.kind === "sign_in") redirect(`/sign-in?${request.query}`)

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Allow {request.name} to use rssify?</CardTitle>
          {request.host ? (
            <CardDescription>
              {request.host} wants to reach your rssify account.
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2">
            {request.scopes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <ConsentButtons name={request.name} />
        </CardFooter>
      </Card>
      <Toaster />
    </main>
  )
}
