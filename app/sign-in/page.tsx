import { CircleAlertIcon } from "lucide-react"
import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { auth } from "@/lib/auth"

import { SignInButton } from "./sign-in-button"

export const metadata: Metadata = { title: "Sign in · rssify" }

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>
}) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (session) redirect("/")
  const { error } = await searchParams

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>rssify</CardTitle>
          <CardDescription>A simple RSS reader.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error === "signup_disabled" ? (
            <Alert>
              <CircleAlertIcon />
              <AlertTitle>Registration is closed</AlertTitle>
              <AlertDescription>
                This rssify doesn’t take new accounts right now. If you already
                have one, sign in with the same Vercel account.
              </AlertDescription>
            </Alert>
          ) : error ? (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>Sign-in didn’t finish</AlertTitle>
              <AlertDescription>
                Something went wrong with Vercel. Try again.
              </AlertDescription>
            </Alert>
          ) : null}
          <SignInButton />
        </CardContent>
      </Card>
    </main>
  )
}
