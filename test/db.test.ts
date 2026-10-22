import { describe, expect, test } from "bun:test"

import { assertTestDatabaseUrl, db } from "./db"

describe("assertTestDatabaseUrl", () => {
  test("accepts the local test database", () => {
    expect(() =>
      assertTestDatabaseUrl("postgresql://rssify@localhost:54329/rssify_test")
    ).not.toThrow()
    expect(() =>
      assertTestDatabaseUrl("postgresql://rssify@127.0.0.1:54329/rssify_test")
    ).not.toThrow()
  })

  test("refuses an unset URL", () => {
    expect(() => assertTestDatabaseUrl(undefined)).toThrow(/not set/)
  })

  test("refuses a remote host", () => {
    expect(() =>
      assertTestDatabaseUrl(
        "postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/rssify_test"
      )
    ).toThrow(/host/)
  })

  test("refuses a host overridden by a query parameter", () => {
    expect(() =>
      assertTestDatabaseUrl(
        "postgresql://rssify@localhost:54329/rssify_test?host=db.example.com"
      )
    ).toThrow(/host is db.example.com/)
  })

  test("refuses a Unix socket host", () => {
    expect(() =>
      assertTestDatabaseUrl(
        "postgresql://rssify@localhost/rssify_test?host=/tmp"
      )
    ).toThrow(/host/)
  })

  test("refuses a non-Postgres protocol", () => {
    expect(() =>
      assertTestDatabaseUrl("socket://localhost/rssify_test")
    ).toThrow(/protocol/)
  })

  test("refuses the dev database", () => {
    expect(() =>
      assertTestDatabaseUrl("postgresql://rssify@localhost:54329/rssify")
    ).toThrow(/database is rssify$/)
  })
})

describe("truncation", () => {
  test("a row written in one test", async () => {
    await db.user.create({
      data: { id: "u1", name: "One", email: "one@example.com" },
    })
    expect(await db.user.count()).toBe(1)
  })

  test("is gone in the next", async () => {
    expect(await db.user.count()).toBe(0)
  })
})
