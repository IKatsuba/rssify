import { oauthProviderClient } from "@better-auth/oauth-provider/client"
import { createAuthClient } from "better-auth/react"

// oauthProviderClient carries the signed OAuth query through sign-in, so an
// MCP authorization resumes after the Vercel round trip.
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] })

// The callback sends a refused sign-up back here as ?error=signup_disabled.
export function signInWithVercel() {
  return authClient.signIn.social({
    provider: "vercel",
    callbackURL: "/",
    errorCallbackURL: "/sign-in",
  })
}
