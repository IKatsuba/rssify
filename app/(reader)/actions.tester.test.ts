import { beforeEach, expect, mock, test } from "bun:test"

// Bun module mocks share a process-wide registry. Keep request/cache seams
// in a child so the signed-out tests and the rest of the suite stay real.
if (process.env.RSSF11_ACTION_TEST_CHILD !== "1") {
  test("signed-in reader action contracts in an isolated process", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: process.cwd(),
      env: { ...process.env, RSSF11_ACTION_TEST_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exit, output: stdout + stderr }).toMatchObject({ exit: 0 })
  }, 30_000)
} else {
  let requestHeaders = new Headers()
  const invalidations: unknown[][] = []
  mock.module("next/headers", () => ({
    headers: async () => requestHeaders,
    cookies: async () => ({ set: () => {} }),
  }))
  mock.module("next/cache", () => ({
    revalidatePath: (...args: unknown[]) => invalidations.push(args),
  }))
  const { serializeSignedCookie } = await import("better-call")
  const { auth } = await import("@/lib/auth")
  const { db } = await import("@/test/db")
  const actions = await import("./actions")
  const cutoff = new Date("2026-01-01T00:00:00Z")

  beforeEach(async () => {
    invalidations.length = 0
    await db.user.createMany({
      data: ["reader", "other"].map((id) => ({
        id,
        name: id,
        email: `${id}@example.com`,
        emailVerified: true,
      })),
    })
    for (const [id, subscribers] of [
      ["shared", ["reader", "other"]],
      ["private", ["other"]],
      ["orphan", ["reader"]],
    ] as const) {
      await db.feed.create({
        data: {
          id,
          url: `https://${id}.example.com/rss`,
          title: id === "orphan" ? null : id,
          subscriptions: { create: subscribers.map((userId) => ({ userId })) },
          entries: {
            create: [
              {
                id: `${id}-old`,
                guid: "old",
                title: "Old",
                sortAt: cutoff,
                createdAt: cutoff,
              },
              {
                id: `${id}-new`,
                guid: "new",
                title: "New",
                sortAt: cutoff,
                createdAt: new Date(cutoff.getTime() + 1),
              },
            ],
          },
        },
      })
    }
    const ctx = await auth.$context
    const session = await ctx.internalAdapter.createSession("reader")
    const cookie = await serializeSignedCookie(
      ctx.authCookies.sessionToken.name,
      session.token,
      ctx.secret
    )
    requestHeaders = new Headers({ cookie: cookie.split(";")[0] })
  })

  function revalidated(times = 1) {
    expect(invalidations).toEqual(
      Array.from({ length: times }, () => ["/", "layout"])
    )
  }

  test("mark read/unread is idempotent and scoped to the session user", async () => {
    await db.readMark.create({
      data: { userId: "other", entryId: "shared-old" },
    })
    expect(await actions.markRead("shared-old")).toEqual({ ok: true })
    expect(await actions.markRead("shared-old")).toEqual({ ok: true })
    expect(await db.readMark.count()).toBe(2)
    expect(await actions.markUnread("shared-old")).toEqual({ ok: true })
    expect(await actions.markUnread("shared-old")).toEqual({ ok: true })
    expect(await db.readMark.findMany({ select: { userId: true } })).toEqual([
      { userId: "other" },
    ])
    revalidated(4)
  })

  test("inaccessible mutations return not_found without invalidating or changing another user's data", async () => {
    await db.readMark.create({
      data: { userId: "other", entryId: "private-old" },
    })
    const calls = [
      () => actions.markRead("private-new"),
      () => actions.markUnread("private-old"),
      () => actions.unsubscribe("private"),
      () =>
        actions.markAllRead({ feedId: "private", upTo: cutoff.toISOString() }),
      () => actions.markRead("missing"),
    ]
    for (const call of calls)
      expect(await call()).toEqual({ ok: false, code: "not_found" })
    expect(await db.readMark.count()).toBe(1)
    expect(await db.subscription.count({ where: { feedId: "private" } })).toBe(
      1
    )
    expect(invalidations).toEqual([])
  })

  test("mark-all accepts a serialized cutoff, includes its boundary and leaves later arrivals unread", async () => {
    expect(
      await actions.markAllRead({
        feedId: "shared",
        upTo: cutoff.toISOString(),
      })
    ).toEqual({ ok: true, marked: 1 })
    expect(
      await actions.markAllRead({ feedId: "shared", upTo: cutoff })
    ).toEqual({ ok: true, marked: 0 })
    expect(
      await db.readMark.findMany({ select: { userId: true, entryId: true } })
    ).toEqual([{ userId: "reader", entryId: "shared-old" }])
    revalidated(2)
  })

  test("mark-all without a feed covers only the session's subscriptions", async () => {
    expect(await actions.markAllRead({ upTo: cutoff })).toEqual({
      ok: true,
      marked: 2,
    })
    expect(
      await db.readMark.count({ where: { entry: { feedId: "private" } } })
    ).toBe(0)
    revalidated()
  })

  test("unsubscribe preserves a shared feed and removes only the session's subscription", async () => {
    expect(await actions.unsubscribe("shared")).toEqual({ ok: true })
    expect(
      await db.subscription.findMany({
        where: { feedId: "shared" },
        select: { userId: true },
      })
    ).toEqual([{ userId: "other" }])
    expect(await db.entry.count({ where: { feedId: "shared" } })).toBe(2)
    revalidated()
  })

  test("last unsubscribe cascades entries and marks", async () => {
    await actions.markRead("orphan-old")
    expect(await actions.unsubscribe("orphan")).toEqual({ ok: true })
    expect(await db.feed.findUnique({ where: { id: "orphan" } })).toBeNull()
    expect(await db.entry.count({ where: { feedId: "orphan" } })).toBe(0)
    expect(await db.readMark.count()).toBe(0)
    revalidated(2)
  })

  test("subscribe to a stored URL does not fetch, returns the title fallback and reports repeat", async () => {
    expect(
      await actions.subscribe({
        url: "https://orphan.example.com/rss#fragment",
      })
    ).toEqual({
      ok: true,
      feedId: "orphan",
      existed: true,
      title: "https://orphan.example.com/rss",
    })
    expect(
      await actions.subscribe({ url: "https://private.example.com/rss" })
    ).toEqual({ ok: true, feedId: "private", existed: false, title: "private" })
    expect(
      await db.subscription.count({
        where: { userId: "reader", feedId: "private" },
      })
    ).toBe(1)
    revalidated(2)
  })

  test("invalid URL and unknown source return codes without network or subscriptions", async () => {
    expect(await actions.subscribe({ url: "not a URL" })).toEqual({
      ok: false,
      code: "invalid_url",
    })
    expect(await actions.subscribe({ source: "does-not-exist" })).toEqual({
      ok: false,
      code: "not_found",
    })
    expect(await db.subscription.count({ where: { userId: "reader" } })).toBe(2)
    revalidated(2)
  })

  test("invalid input throws before mutations and revalidation", async () => {
    await expect(
      actions.markRead(7 as unknown as string)
    ).rejects.toBeInstanceOf(TypeError)
    await expect(actions.unsubscribe("")).rejects.toBeInstanceOf(TypeError)
    await expect(
      actions.markAllRead({ upTo: "bad-date" })
    ).rejects.toBeInstanceOf(TypeError)
    expect(await db.readMark.count()).toBe(0)
    expect(invalidations).toEqual([])
  })

  test("an API key header alone cannot authorize a reader action", async () => {
    requestHeaders = new Headers({ "x-api-key": "rss_invalid" })
    await expect(actions.markRead("shared-old")).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT;replace;/sign-in;"),
    })
    expect(await db.readMark.count()).toBe(0)
    expect(invalidations).toEqual([])
  })
}
