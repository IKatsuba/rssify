import { createAuthClient } from "better-auth/react"

export const authClient = createAuthClient()

// The callback sends a refused sign-up back here as ?error=signup_disabled.
export function signInWithVercel() {
  return authClient.signIn.social({
    provider: "vercel",
    callbackURL: "/",
    errorCallbackURL: "/sign-in",
  })
}
