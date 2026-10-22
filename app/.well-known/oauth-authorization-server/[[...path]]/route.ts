import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider"

import { auth } from "@/lib/auth"

// RFC 8414 metadata for the issuer <BETTER_AUTH_URL>/api/auth, which clients
// look up at /.well-known/oauth-authorization-server/api/auth.
export const GET = oauthProviderAuthServerMetadata(auth)
