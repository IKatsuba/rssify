// Signs a local user in without Vercel, for checking signed-in screens on the
// dev server: creates the user (if missing) and a session in the docker
// database, and prints the session cookie to set on localhost:3210.
//
//   bun --env-file=.env.local scripts/dev-session.ts [email]
import { serializeSignedCookie } from "better-call"

import { auth } from "@/lib/auth"
import { assertLocalDatabaseUrl } from "@/lib/local-database"

assertLocalDatabaseUrl(process.env.DATABASE_URL)

const email = process.argv[2] ?? "reader@example.com"
const ctx = await auth.$context

let user = (await ctx.internalAdapter.findUserByEmail(email))?.user
if (!user) {
  // The gate would refuse a new account while registration is closed.
  process.env.REGISTRATION_ENABLED = "true"
  user = await ctx.internalAdapter.createUser(
    { name: "Local Reader", email, emailVerified: true },
    { method: "oauth", oauth: { providerId: "vercel" } }
  )
}

const session = await ctx.internalAdapter.createSession(user.id)
const cookie = await serializeSignedCookie(
  ctx.authCookies.sessionToken.name,
  session.token,
  ctx.secret
)
console.log(cookie.split(";")[0])
process.exit(0)
