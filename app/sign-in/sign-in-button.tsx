"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { VercelLogo } from "@/components/vercel-logo"
import { signInWithVercel } from "@/lib/auth-client"

export function SignInButton() {
  const router = useRouter()
  const [redirecting, setRedirecting] = useState(false)

  async function signIn() {
    setRedirecting(true)
    const { error } = await signInWithVercel()
    // On success the browser is already leaving for Vercel; stay disabled.
    // A failure before the redirect shows the same state as a failed callback.
    if (error) {
      setRedirecting(false)
      router.replace("/sign-in?error=sign_in_failed")
    }
  }

  return (
    <Button className="w-full" disabled={redirecting} onClick={signIn}>
      {redirecting ? (
        <>
          <Spinner data-icon="inline-start" aria-hidden />
          Redirecting to Vercel…
        </>
      ) : (
        <>
          <VercelLogo data-icon="inline-start" />
          Sign in with Vercel
        </>
      )}
    </Button>
  )
}
