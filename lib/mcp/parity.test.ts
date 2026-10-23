import { expect, mock, test } from "bun:test"
import type { ZodType } from "zod"

// One scenario through the server actions, /api/v1 and MCP (design §5.5,
// §12 parity) must give the same data, parsed by the same schema objects.
// Module mocks are process-wide in Bun, so the scenario runs in a child.
if (process.env.RSSF15_PARITY_CHILD !== "1") {
  test("actions, /api/v1 and MCP agree, in an isolated process", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: process.cwd(),
      env: { ...process.env, RSSF15_PARITY_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exit, output: stdout + stderr }).toMatchObject({ exit: 0 })
  }, 60_000)
} else {
  const { readFileSync } = await import("node:fs")

  // Which adapter is calling, and which shared schemas it parsed with.
  let adapter = ""
  const parsedWith = new Map<string, Set<string>>()
  const realSchemas = await import("@/lib/reader-schemas")
  const watched = Object.fromEntries(
    Object.entries(realSchemas).map(([name, schema]) => [
      name,
      (schema as ZodType).refine(() => {
        if (!parsedWith.has(adapter)) parsedWith.set(adapter, new Set())
        parsedWith.get(adapter)!.add(name)
        return true
      }),
    ])
  )
  mock.module("@/lib/reader-schemas", () => watched)

  // The one site the scenario reaches, answered from fixtures.
  const page = "https://blog.example.com/"
  const choices = [
    "https://blog.example.com/rss.xml",
    "https://blog.example.com/atom.xml",
  ]
  const html = `<!DOCTYPE html><html><head>${["/rss.xml", "/atom.xml"]
    .map(
      (href) =>
        `<link rel="alternate" type="application/rss+xml" href="${href}">`
    )
    .join("")}</head></html>`
  const rss = readFileSync("test/fixtures/feeds/claude-dev.rss.xml", "utf8")
  const realFetch = await import("@/lib/ingest/safe-fetch")
  mock.module("@/lib/ingest/safe-fetch", () => ({
    ...realFetch,
    safeFetch: async (url: string) => {
      if (url === page) {
        const headers = new Headers({ "content-type": "text/html" })
        return { status: 200, url, headers, text: html, kind: "unknown" }
      }
      if (url === choices[0]) {
        return {
          status: 200,
          url,
          headers: new Headers(),
          text: rss,
          kind: "xml",
        }
      }
      throw new Error(`unexpected fetch of ${url}`)
    },
  }))

  let requestHeaders = new Headers()
  mock.module("next/headers", () => ({
    headers: async () => requestHeaders,
    cookies: async () => ({ set: () => {} }),
  }))
  mock.module("next/cache", () => ({ revalidatePath: () => {} }))

  const actions = await import("@/app/(reader)/actions")
  const subscriptionsRoute = await import("@/app/api/v1/subscriptions/route")
  const subscriptionRoute =
    await import("@/app/api/v1/subscriptions/[feedId]/route")
  const entriesRoute = await import("@/app/api/v1/entries/route")
  const entryRoute = await import("@/app/api/v1/entries/[id]/route")
  const readRoute = await import("@/app/api/v1/entries/[id]/read/route")
  const readAllRoute = await import("@/app/api/v1/entries/read/route")
  const mcpRoute = await import("@/app/api/mcp/route")
  const reader = await import("@/lib/reader")
  const { toJson } = await import("@/lib/reader-output")
  const { auth } = await import("@/lib/auth")
  const { createUserWithSession } = await import("@/test/mcp-token")
  const { callTool } = await import("@/test/mcp-rpc")
  // test/db truncates before each test, so each adapter starts from nothing.
  await import("@/test/db")

  type Failure = { code: string; message?: string; choices?: string[] }
  type Data = Record<string, unknown>

  // Each adapter's doors, answering plain JSON data or a failure.
  type Doors = {
    subscribe(input: Data): Promise<{ feedId: string } | Failure>
    listFeeds(): Promise<Data[]>
    listEntries(input: Data): Promise<{ entries: Data[]; asOf: string }>
    getEntry(entryId: string): Promise<Data>
    markRead(entryId: string): Promise<void>
    markUnread(entryId: string): Promise<void>
    markAllRead(input: Data): Promise<number>
    unsubscribe(feedId: string): Promise<void>
  }

  // The actions write; the pages read through lib/reader.ts loaders.
  async function actionDoors(): Promise<Doors> {
    const cookie = await createUserWithSession("u1")
    requestHeaders = new Headers({ cookie })
    const userId = "u1"
    return {
      async subscribe(input) {
        const result = await actions.subscribe(input as { url: string })
        // The failure without its ok flag, as the other two answer it.
        if (!result.ok) {
          const failure: Failure = { ...result }
          delete (failure as { ok?: boolean }).ok
          return failure
        }
        return { feedId: result.feedId }
      },
      listFeeds: async () =>
        toJson(await reader.listSubscriptions(userId)) as Data[],
      async listEntries(input) {
        const list = await reader.listEntries(userId, input)
        return toJson({ entries: list.entries, asOf: list.asOf }) as {
          entries: Data[]
          asOf: string
        }
      },
      getEntry: async (entryId) =>
        toJson(await reader.getEntry(userId, entryId)) as Data,
      markRead: async (entryId) => void (await actions.markRead(entryId)),
      markUnread: async (entryId) => void (await actions.markUnread(entryId)),
      async markAllRead(input) {
        const result = await actions.markAllRead(
          input as { upTo: string; feedId?: string }
        )
        if (!result.ok) throw new Error(result.code)
        return result.marked
      },
      unsubscribe: async (feedId) => void (await actions.unsubscribe(feedId)),
    }
  }

  async function apiDoors(): Promise<Doors> {
    await createUserWithSession("u1")
    const { key } = await auth.api.createApiKey({ body: { userId: "u1" } })
    const call = (path: string, method = "GET", body?: unknown) =>
      new Request(`http://localhost:3210/api/v1${path}`, {
        method,
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    const params = <T>(value: T) => ({ params: Promise.resolve(value) })
    const ok = async (res: Response) => {
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
      return res.status === 204 ? undefined : res.json()
    }
    return {
      async subscribe(input) {
        const res = await subscriptionsRoute.POST(
          call("/subscriptions", "POST", input)
        )
        if (res.status === 422) return (await res.json()).error
        return { feedId: (await ok(res)).subscription.feed.id }
      },
      listFeeds: async () =>
        (await ok(await subscriptionsRoute.GET(call("/subscriptions"))))
          .subscriptions,
      async listEntries(input) {
        const query = new URLSearchParams(
          Object.entries(input).map(([k, v]) =>
            k === "unreadOnly" ? ["unread", String(v)] : [k, String(v)]
          )
        )
        const body = await ok(await entriesRoute.GET(call(`/entries?${query}`)))
        return { entries: body.entries, asOf: body.asOf }
      },
      getEntry: async (id) =>
        (await ok(await entryRoute.GET(call(`/entries/${id}`), params({ id }))))
          .entry,
      markRead: async (id) =>
        ok(
          await readRoute.PUT(
            call(`/entries/${id}/read`, "PUT"),
            params({ id })
          )
        ),
      markUnread: async (id) =>
        ok(
          await readRoute.DELETE(
            call(`/entries/${id}/read`, "DELETE"),
            params({ id })
          )
        ),
      markAllRead: async (input) =>
        (
          await ok(
            await readAllRoute.POST(call("/entries/read", "POST", input))
          )
        ).marked,
      unsubscribe: async (feedId) =>
        ok(
          await subscriptionRoute.DELETE(
            call(`/subscriptions/${feedId}`, "DELETE"),
            params({ feedId })
          )
        ),
    }
  }

  async function mcpDoors(): Promise<Doors> {
    await createUserWithSession("u1")
    const { key } = await auth.api.createApiKey({ body: { userId: "u1" } })
    const tool = async (name: string, args: Data = {}) => {
      const result = await callTool(mcpRoute.POST, name, args, {
        headers: { "x-api-key": key },
      })
      // The text block is the structuredContent, as the tool tests pin.
      const json = JSON.parse(result.content[0].text)
      return result.isError ? { failure: json } : { data: json }
    }
    const must = async (name: string, args?: Data) => {
      const { data, failure } = await tool(name, args)
      if (failure) throw new Error(JSON.stringify(failure))
      return data!
    }
    return {
      async subscribe(input) {
        const { data, failure } = await tool("subscribe", input)
        return failure ?? { feedId: data!.subscription.feed.id }
      },
      listFeeds: async () => (await must("list_feeds")).subscriptions,
      async listEntries(input) {
        const { entries, asOf } = await must("list_entries", input)
        return { entries, asOf }
      },
      getEntry: async (entryId) => (await must("get_entry", { entryId })).entry,
      markRead: async (entryId) => void (await must("mark_read", { entryId })),
      markUnread: async (entryId) =>
        void (await must("mark_unread", { entryId })),
      markAllRead: async (input) => (await must("mark_all_read", input)).marked,
      unsubscribe: async (feedId) =>
        void (await must("unsubscribe", { feedId })),
    }
  }

  // Ids and times of this run differ between runs; the rest must not.
  function stable(value: unknown, feedId: string): unknown {
    return JSON.parse(
      JSON.stringify(value, (key, v) =>
        ["createdAt", "lastSuccessAt", "asOf"].includes(key)
          ? typeof v
          : v === feedId
            ? "<feed>"
            : key === "id"
              ? "<id>"
              : v
      )
    )
  }

  async function scenario(doors: Doors) {
    const steps: Record<string, unknown> = {}
    const multiple = (await doors.subscribe({ url: page })) as Failure
    steps.multiple = multiple
    const added = await doors.subscribe({ url: multiple.choices![0] })
    if (!("feedId" in added)) throw new Error(JSON.stringify(added))
    const { feedId } = added
    steps.again = await doors.subscribe({ url: multiple.choices![0] })
    steps.feeds = await doors.listFeeds()
    const first = await doors.listEntries({ feedId, limit: 3 })
    steps.firstPage = first.entries
    const entryId = first.entries[0].id as string
    await doors.markRead(entryId)
    steps.unread = (await doors.listEntries({ unreadOnly: true })).entries
    steps.entry = await doors.getEntry(entryId)
    await doors.markUnread(entryId)
    steps.entryAfterUnread = await doors.getEntry(entryId)
    const { asOf } = await doors.listEntries({})
    steps.marked = await doors.markAllRead({ feedId, upTo: asOf })
    steps.feedsAfterMarkAll = await doors.listFeeds()
    await doors.unsubscribe(feedId)
    steps.feedsAfterUnsubscribe = await doors.listFeeds()
    return stable(steps, feedId)
  }

  const results = new Map<string, unknown>()
  for (const [name, doors] of [
    ["action", actionDoors],
    ["api", apiDoors],
    ["mcp", mcpDoors],
  ] as const) {
    test(`the scenario through ${name}`, async () => {
      adapter = name
      results.set(name, await scenario(await doors()))
    }, 30_000)
  }

  test("gives the same data through all three", () => {
    const action = results.get("action") as Record<string, unknown>
    const api = results.get("api") as Record<string, unknown>
    const mcp = results.get("mcp") as Record<string, unknown>
    expect(mcp).toEqual(api)
    // Actions return a code and choices; the sentence is the dialog's.
    const { message, ...actionMultiple } = api.multiple as Failure
    expect(message).toBe("blog.example.com has more than one feed. Pick one.")
    expect(action).toEqual({ ...api, multiple: actionMultiple })
    expect(api.again).toEqual({ feedId: "<feed>" })
    expect(api.marked).toBeGreaterThan(0)
    expect(api.feedsAfterUnsubscribe).toEqual([])
  })

  test("all three parse with the same schema objects", () => {
    const writes = [
      "subscribeInput",
      "unsubscribeInput",
      "markReadInput",
      "markUnreadInput",
      "markAllReadInput",
    ]
    const reads = ["listEntriesInput", "getEntryInput"]
    expect([...parsedWith.get("action")!].sort()).toEqual(writes.sort())
    for (const name of ["api", "mcp"]) {
      expect([...parsedWith.get(name)!].sort()).toEqual(
        [...writes, ...reads].sort()
      )
    }
  })
}
