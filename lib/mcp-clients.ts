import { describeClient } from "@/lib/consent"
import { db } from "@/lib/db"

// Settings → Connected apps: one row per app the user has consented to.
// oauthConsent has no unique (userId, clientId), so an app with several
// consents is still one row, dated by its latest.
export async function listConnectedApps(userId: string) {
  const consents = await db.oauthConsent.findMany({
    where: { userId },
    // The provider stores whole seconds; clientId keeps ties in a stable order.
    orderBy: [{ createdAt: "desc" }, { clientId: "asc" }],
    select: {
      clientId: true,
      createdAt: true,
      oauthclient: { select: { name: true, uri: true } },
    },
  })
  // Newest first, so the first consent seen for a client is its latest.
  const latest = consents.filter(
    (consent, i) =>
      consents.findIndex((other) => other.clientId === consent.clientId) === i
  )
  return latest.map(({ clientId, createdAt, oauthclient }) => ({
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
// here, together, for every consent the user gave this app: the app cannot refresh, and asks again to come back. An
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
