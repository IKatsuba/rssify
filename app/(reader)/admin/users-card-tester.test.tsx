import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { UsersCard } from "./users-card"

test("only other users have delete controls, including with no subscriptions", () => {
  const html = renderToStaticMarkup(
    <UsersCard
      registration="closed"
      users={[
        {
          id: "self",
          email: "self@example.com",
          joined: "Jan 1, 2026",
          feeds: 0,
          you: true,
        },
        {
          id: "other",
          email: "other@example.com",
          joined: "Jan 2, 2026",
          feeds: 0,
          you: false,
        },
      ]}
    />
  )
  const rows = html.split("<tr").slice(2)
  expect(rows).toHaveLength(2)
  expect(rows[0]).toContain("you")
  expect(rows[0]).not.toContain("<button")
  expect(rows[1]).toContain("Delete")
})

test("empty users list renders the registration state without delete controls", () => {
  const html = renderToStaticMarkup(
    <UsersCard registration="open" users={[]} />
  )
  expect(html).toContain("Registration is open.")
  expect(html).toContain("REGISTRATION_ENABLED")
  expect(html).not.toContain("<button")
})

test("user-provided email is rendered as escaped text", () => {
  const html = renderToStaticMarkup(
    <UsersCard
      registration="closed"
      users={[
        {
          id: "other",
          email: "<script>alert(1)</script>@example.com",
          joined: "Jan 1, 2026",
          feeds: 1,
          you: false,
        },
      ]}
    />
  )
  expect(html).not.toContain("<script>")
  expect(html).toContain("&lt;script&gt;")
})
