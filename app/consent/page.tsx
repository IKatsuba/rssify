import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { loadConsent } from "@/lib/consent"

import { ConsentButtons } from "./consent-buttons"

// The provider sends the browser here with a signed query; consent is never
// skipped, and every requested scope is shown before it can be granted.
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const request = await loadConsent(await searchParams, await headers())
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
          <ConsentButtons />
        </CardFooter>
      </Card>
    </main>
  )
}
