import { expect, mock, test } from "bun:test"

// Keep request mocks isolated from other files in Bun's shared module registry.
if (process.env.RSSF13_SCHEMA_ACTION_CHILD !== "1") {
  test("shared-schema action boundaries in an isolated process", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, RSSF13_SCHEMA_ACTION_CHILD: "1" },
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

  const invalidCalls = [
    () =>
      actions.subscribe({
        url: "https://example.com",
        source: "cursor-blog",
      } as never),
    () => actions.subscribe({} as never),
    () => actions.unsubscribe(null as never),
    () => actions.markRead(""),
    () => actions.markUnread(7 as never),
    () => actions.markAllRead({ upTo: "2026-02-30T00:00:00Z" }),
    () => actions.markAllRead({ upTo: "2026-10-22T00:00:00" }),
  ]

  test("signed-out malformed inputs redirect before schema parsing", async () => {
    requestHeaders = new Headers()
    for (const call of invalidCalls) {
      await expect(call()).rejects.toMatchObject({
        digest: expect.stringContaining("NEXT_REDIRECT;replace;/sign-in;"),
      })
    }
    expect(invalidations).toEqual([])
    expect(await db.subscription.count()).toBe(0)
  })

  test("signed-in malformed inputs throw TypeError without writes or revalidation", async () => {
    await db.user.create({
      data: {
        id: "schema-reader",
        name: "Reader",
        email: "schema@example.com",
      },
    })
    const ctx = await auth.$context
    const session = await ctx.internalAdapter.createSession("schema-reader")
    const cookie = await serializeSignedCookie(
      ctx.authCookies.sessionToken.name,
      session.token,
      ctx.secret
    )
    requestHeaders = new Headers({ cookie: cookie.split(";")[0] })
    for (const call of invalidCalls) {
      await expect(call()).rejects.toBeInstanceOf(TypeError)
    }
    expect(invalidations).toEqual([])
    expect(await db.feed.count()).toBe(0)
    expect(await db.subscription.count()).toBe(0)
    expect(await db.readMark.count()).toBe(0)
  })
}
