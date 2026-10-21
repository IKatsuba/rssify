// Gives a local user mock subscriptions and entries covering every reader
// state, for checking screens on the dev server: many unread, some read, a
// feed with no entries, a failing and a gone feed, entries with content,
// summary only, nothing or no URL, a long <pre>, and more than one page.
// Running it again replaces the mock feeds; real feeds are left alone.
//
//   bun --env-file=.env.local scripts/dev-seed.ts [email]
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import type { Prisma } from "@/lib/generated/prisma/client"
import { assertLocalDatabaseUrl } from "@/lib/local-database"

assertLocalDatabaseUrl(process.env.DATABASE_URL)

const email = process.argv[2] ?? "reader@example.com"
// Mock feeds live under .example (RFC 2606), so they can never be real.
const host = (name: string) => `https://${name}.rssify.example`
const now = Date.now()
const hoursAgo = (hours: number) => new Date(now - hours * 60 * 60 * 1000)
// Far enough ahead that scripts/refresh.ts never claims a mock feed.
const never = new Date(now + 100 * 365 * 24 * 60 * 60 * 1000)

const longPre = Array.from(
  { length: 12 },
  (_, i) =>
    `step_${i} = run("bun --env-file=.env.local scripts/refresh.ts --verbose --feed=${"x".repeat(40)}") # line ${i}`
).join("\n")

const richContent = `
<p>Hooks run your own commands at points in the agent loop. Here is how to
write one that formats on save and blocks a risky command.</p>
<h2>Where hooks run</h2>
<p>Each hook gets the event as JSON on stdin and answers with an exit code.
See <a href="https://example.com/docs" rel="noopener noreferrer nofollow" target="_blank">the reference</a>.</p>
<ul><li>Before a tool call</li><li>After a tool call</li><li>When the session stops</li></ul>
<blockquote><p>Keep hooks fast: they run on every call.</p></blockquote>
<p>A short one, with <code>inline code</code>:</p>
<pre><code>${longPre}</code></pre>
<h3>Ordered steps</h3>
<ol><li>Write the script.</li><li>Register it.</li><li>Try it on a scratch repo.</li></ol>
<p>That is all there is to it.</p>`

type MockEntry = {
  title: string
  summary?: string | null
  contentHtml?: string | null
  url?: string | null
  hoursAgo: number
  read?: boolean
}

type MockFeed = {
  slug: string
  title: string
  status?: "ok" | "failing" | "gone"
  lastError?: string
  failureCount?: number
  lastSuccessHoursAgo?: number
  entries: MockEntry[]
}

const paragraphs = (title: string) =>
  `<p>${title}. The first paragraph of a mock entry, long enough to wrap
across a couple of lines in the reading column.</p><p>A second paragraph
follows, so the spacing between paragraphs shows.</p>`

const feeds: MockFeed[] = [
  {
    slug: "long-read-weekly",
    title: "Long Read Weekly",
    // More than one page of 50 under both filters, read and unread mixed.
    entries: Array.from({ length: 64 }, (_, i) => ({
      title: `Issue ${64 - i}: notes from the week`,
      summary: `What we read in week ${64 - i}, and a few links worth keeping. A mock summary long enough to need two lines in the list, so the clamp shows where it cuts off the rest of the text.`,
      contentHtml: paragraphs(`Issue ${64 - i}`),
      url: `${host("long-read-weekly")}/issues/${64 - i}`,
      hoursAgo: 1 + i * 7,
      read: i % 5 === 3,
    })),
  },
  {
    slug: "variety",
    title: "Content Variety",
    entries: [
      {
        title: "Hooks, explained",
        summary:
          "Hooks run your own commands at points in the agent loop. Here is how to write one that formats on save and blocks a risky command.",
        contentHtml: richContent,
        url: `${host("variety")}/hooks-explained`,
        hoursAgo: 2,
      },
      {
        title: "Summary only, no content",
        summary:
          "This entry came with a summary and nothing else, so the entry view shows the summary and a link to the original.",
        url: `${host("variety")}/summary-only`,
        hoursAgo: 5,
      },
      {
        title: "No text at all",
        url: `${host("variety")}/no-text`,
        hoursAgo: 8,
      },
      {
        title: "No text and no link",
        hoursAgo: 11,
      },
      {
        title: "Content without a link",
        summary: "An entry whose feed gave no URL, so Open original is off.",
        contentHtml: paragraphs("Content without a link"),
        hoursAgo: 30,
      },
      {
        title: "Already read",
        summary: "A read entry, muted under All and hidden under Unread.",
        contentHtml: paragraphs("Already read"),
        url: `${host("variety")}/already-read`,
        hoursAgo: 50,
        read: true,
      },
    ],
  },
  {
    slug: "caught-up",
    title: "Julia’s Notes",
    // Every entry read: the feed's Unread list is empty, All is not.
    entries: Array.from({ length: 4 }, (_, i) => ({
      title: `A note on ${["DNS", "TCP", "TLS", "HTTP"][i]}`,
      summary: `A short note about ${["DNS", "TCP", "TLS", "HTTP"][i]}.`,
      contentHtml: paragraphs(`A note on ${["DNS", "TCP", "TLS", "HTTP"][i]}`),
      url: `${host("caught-up")}/${i}`,
      hoursAgo: 20 + i * 24,
      read: true,
    })),
  },
  {
    slug: "quiet",
    title: "Quiet Feed",
    entries: [],
  },
  {
    slug: "failing",
    title: "An old blog",
    status: "failing",
    lastError: "the site answered 404 Not Found",
    failureCount: 4,
    lastSuccessHoursAgo: 6 * 24,
    entries: [
      {
        title: "The last post before it broke",
        summary: "Read already, so the Unread list of this feed is empty.",
        contentHtml: paragraphs("The last post before it broke"),
        url: `${host("failing")}/last`,
        hoursAgo: 7 * 24,
        read: true,
      },
    ],
  },
  {
    slug: "gone",
    title: "Gone Gazette",
    status: "gone",
    lastError: "the site answered 410 Gone",
    failureCount: 1,
    lastSuccessHoursAgo: 3 * 24,
    entries: [
      {
        title: "Goodbye, and thanks for reading",
        summary: "The final issue: the gazette stops here.",
        contentHtml: paragraphs("Goodbye, and thanks for reading"),
        url: `${host("gone")}/goodbye`,
        hoursAgo: 4 * 24,
      },
      {
        title: "The penultimate issue",
        summary: "One before the last.",
        url: `${host("gone")}/penultimate`,
        hoursAgo: 11 * 24,
        read: true,
      },
    ],
  },
]

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
const userId = user.id

try {
  await db.$transaction(async (tx) => {
    // Cascades their entries, subscriptions and read marks.
    await tx.feed.deleteMany({
      where: { url: { in: feeds.map((f) => `${host(f.slug)}/feed.xml`) } },
    })
    for (const mock of feeds) {
      const status = mock.status ?? "ok"
      const lastSuccessAt = hoursAgo(mock.lastSuccessHoursAgo ?? 0.5)
      const feed = await tx.feed.create({
        data: {
          url: `${host(mock.slug)}/feed.xml`,
          title: mock.title,
          siteUrl: host(mock.slug),
          status,
          nextFetchAt: status === "gone" ? null : never,
          lastFetchedAt: hoursAgo(0.5),
          lastSuccessAt,
          failureCount: mock.failureCount ?? 0,
          lastError: mock.lastError ?? null,
          subscriptions: { create: { userId } },
        },
      })
      const entries = mock.entries.map(
        (entry, i): Prisma.EntryCreateManyInput => ({
          feedId: feed.id,
          guid: `${mock.slug}-${i}`,
          title: entry.title,
          summary: entry.summary ?? null,
          contentHtml: entry.contentHtml ?? null,
          url: entry.url ?? null,
          author: "Mock Author",
          publishedAt: hoursAgo(entry.hoursAgo),
          sortAt: hoursAgo(entry.hoursAgo),
          createdAt: hoursAgo(entry.hoursAgo),
        })
      )
      const created = await tx.entry.createManyAndReturn({
        data: entries,
        select: { id: true, guid: true },
      })
      const readGuids = new Set(
        mock.entries.flatMap((e, i) => (e.read ? [`${mock.slug}-${i}`] : []))
      )
      await tx.readMark.createMany({
        data: created
          .filter((e) => readGuids.has(e.guid))
          .map((e) => ({ userId, entryId: e.id })),
      })
    }
  })
  console.log(`Seeded ${feeds.length} mock feeds for ${email}`)
} finally {
  await db.$disconnect()
}
process.exit(0)
