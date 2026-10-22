import { describeClient } from "@/lib/consent"
import { db } from "@/lib/db"

// Settings → Connected apps: one row per app the user has consented to.
export async function listConnectedApps(userId: string) {
  const consents = await db.oauthConsent.findMany({
    where: { userId },
    // The provider stores whole seconds; id keeps ties in a stable order.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      clientId: true,
      createdAt: true,
      oauthclient: { select: { name: true, uri: true } },
    },
  })
  return consents.map(({ clientId, createdAt, oauthclient }) => ({
    clientId,
    ...describeClient({
      client_id: clientId,
      client_name: oauthclient.name ?? undefined,
      client_uri: oauthclient.uri ?? undefined,
    }),
    createdAt,
  }))
}

// better-auth's own delete-consent leaves refresh tokens alive, so both go
// here, together: the app cannot refresh, and asks again to come back. An
// access token already issued lasts until it expires (1 h, design §5.5).
export async function disconnectApp(userId: string, clientId: string) {
  const [consents] = await db.$transaction([
    db.oauthConsent.deleteMany({ where: { userId, clientId } }),
    db.oauthRefreshToken.updateMany({
      where: { userId, clientId, revoked: null },
      data: { revoked: new Date() },
    }),
  ])
  if (consents.count === 0) {
    return { ok: false as const, code: "not_found" as const }
  }
  return { ok: true as const }
}
