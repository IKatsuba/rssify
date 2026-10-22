import { db } from "@/lib/db"

// Nothing else prunes these: the provider leaves expired refresh and opaque
// access tokens, and private_key_jwt assertion digests, in place. Each is
// one indexed delete; CIMD clients stay (one row per app, not per user).
export async function deleteExpiredAuthRows(now = new Date()) {
  const where = { expiresAt: { lt: now } }
  const [refreshTokens, accessTokens, clientAssertions] = await Promise.all([
    db.oauthRefreshToken.deleteMany({ where }),
    db.oauthAccessToken.deleteMany({ where }),
    db.oauthClientAssertion.deleteMany({ where }),
  ])
  return {
    refreshTokens: refreshTokens.count,
    accessTokens: accessTokens.count,
    clientAssertions: clientAssertions.count,
  }
}
