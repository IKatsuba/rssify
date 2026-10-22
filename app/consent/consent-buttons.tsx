"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth-client"

export function ConsentButtons() {
  const [busy, setBusy] = useState(false)

  // oauthProviderClient adds the page's signed query, and the client follows
  // the redirect the provider returns: a code, or access_denied.
  async function answer(accept: boolean) {
    setBusy(true)
    const { error } = await authClient.oauth2.consent({ accept })
    if (error) setBusy(false)
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
