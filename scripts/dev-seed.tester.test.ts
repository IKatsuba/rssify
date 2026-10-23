import { expect, test } from "bun:test"

import { assertTestDatabaseUrl, db } from "@/test/db"

async function seed() {
  assertTestDatabaseUrl(process.env.DATABASE_URL)
  const child = Bun.spawn(
    [process.execPath, "scripts/dev-seed.ts", "seed-tester@example.invalid"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BETTER_AUTH_URL: "http://localhost:3210",
        BETTER_AUTH_SECRET:
          "local-test-only-placeholder-secret-at-least-32-chars",
        VERCEL_CLIENT_ID: "test-placeholder",
        VERCEL_CLIENT_SECRET: "test-placeholder",
        REGISTRATION_ENABLED: "false",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exit, diagnostic: exit === 0 ? "" : stderr }).toEqual({
    exit: 0,
    diagnostic: "",
  })
  expect(stdout).toContain("Seeded 6 mock feeds")
}

test("local mock seed covers reader states and safely replaces its fixtures on rerun", async () => {
  const existing = await db.user.create({
    data: {
      id: "seed-existing-owner",
      name: "Existing",
      email: "existing@example.invalid",
    },
  })
  const preserved = await db.feed.create({
    data: {
      url: "https://preserved.example.invalid/feed",
      subscriptions: { create: { userId: existing.id } },
      entries: {
        create: { guid: "preserved", title: "Keep this", sortAt: new Date() },
      },
    },
    include: { entries: true },
  })
  await db.readMark.create({
    data: { userId: existing.id, entryId: preserved.entries[0].id },
  })

  await seed()
  const user = await db.user.findUniqueOrThrow({
    where: { email: "seed-tester@example.invalid" },
  })
  const readFixtures = () =>
    db.feed.findMany({
      where: { subscriptions: { some: { userId: user.id } } },
      include: { entries: { include: { readMarks: true } } },
      orderBy: { title: "asc" },
    })
  const feeds = await readFixtures()
  expect(feeds).toHaveLength(6)
  const many = feeds.find((f) => f.title === "Long Read Weekly")!
  expect(many.entries).toHaveLength(64)
  expect(
    many.entries.filter((e) => e.readMarks.length === 0).length
  ).toBeGreaterThan(50)
  expect(many.entries.some((e) => e.readMarks.length === 1)).toBe(true)
  expect(feeds.find((f) => f.title === "Quiet Feed")!.entries).toHaveLength(0)
  expect(
    feeds
      .find((f) => f.title === "Julia’s Notes")!
      .entries.every((e) => e.readMarks.length === 1)
  ).toBe(true)
  expect(feeds.find((f) => f.status === "failing")).toMatchObject({
    failureCount: 4,
    lastError: "the site answered 404 Not Found",
  })
  expect(feeds.find((f) => f.status === "gone")!.nextFetchAt).toBeNull()
  expect(
    feeds
      .filter((f) => f.status !== "gone")
      .every((f) => f.nextFetchAt!.getTime() > Date.now() + 365 * 86400000)
  ).toBe(true)
  const variety = feeds.find((f) => f.title === "Content Variety")!.entries
  expect(
    variety.find((e) => e.title === "Summary only, no content")
  ).toMatchObject({
    contentHtml: null,
    summary: expect.any(String),
    url: expect.any(String),
  })
  expect(variety.find((e) => e.title === "No text and no link")).toMatchObject({
    contentHtml: null,
    summary: null,
    url: null,
  })
  expect(
    variety.find((e) => e.title === "Hooks, explained")!.contentHtml
  ).toContain("<pre><code>")

  await seed()
  const replaced = await readFixtures()
  expect(replaced).toHaveLength(6)
  expect(replaced.flatMap((f) => f.entries)).toHaveLength(
    feeds.flatMap((f) => f.entries).length
  )
  expect(await db.user.count({ where: { email: user.email } })).toBe(1)
  expect(await db.readMark.count({ where: { userId: user.id } })).toBe(
    feeds.flatMap((f) => f.entries).filter((e) => e.readMarks.length > 0).length
  )
  expect(
    await db.feed.findUnique({ where: { id: preserved.id } })
  ).not.toBeNull()
  expect(await db.readMark.count({ where: { userId: existing.id } })).toBe(1)
}, 20000)
