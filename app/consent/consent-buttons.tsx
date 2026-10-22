"use client"

import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth-client"

export function ConsentButtons({ name }: { name: string }) {
  const [busy, setBusy] = useState(false)

  // oauthProviderClient adds the page's signed query, and the client follows
  // the redirect the provider returns: a code, or access_denied.
  async function answer(accept: boolean) {
    setBusy(true)
    const { error } = await authClient.oauth2
      .consent({ accept })
      .catch(() => ({ error: true }))
    if (error) {
      toast.error(`Couldn’t finish connecting ${name}. Try again.`)
      setBusy(false)
    }
  }

  return (
    <>
      <Button variant="outline" disabled={busy} onClick={() => answer(false)}>
        Deny
      </Button>
      <Button disabled={busy} onClick={() => answer(true)}>
        Allow
      </Button>
    </>
  )
}
