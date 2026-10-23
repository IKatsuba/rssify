import { describe, expect, test } from "bun:test"

import { assertLocalDatabaseUrl } from "./local-database"

describe("assertLocalDatabaseUrl", () => {
  test("accepts the docker database and returns its name", () => {
    expect(
      assertLocalDatabaseUrl("postgresql://rssify@localhost:54329/rssify")
    ).toBe("rssify")
    expect(
      assertLocalDatabaseUrl("postgres://rssify@127.0.0.1:54329/rssify")
    ).toBe("rssify")
  })

  test("refuses an unset URL", () => {
    expect(() => assertLocalDatabaseUrl(undefined)).toThrow(/not set/)
  })

  test("refuses a remote host", () => {
    expect(() =>
      assertLocalDatabaseUrl("postgresql://u@ep-x.aws.neon.tech/rssify")
    ).toThrow(/host/)
  })

  test("refuses a host overridden by a query parameter", () => {
    expect(() =>
      assertLocalDatabaseUrl(
        "postgresql://rssify@localhost:54329/rssify?host=db.example.com"
      )
    ).toThrow(/host is db.example.com/)
  })

  test("refuses a Unix socket host", () => {
    expect(() =>
      assertLocalDatabaseUrl("postgresql://rssify@localhost/rssify?host=/tmp")
    ).toThrow(/host/)
  })

  test("refuses a non-Postgres protocol", () => {
    expect(() => assertLocalDatabaseUrl("socket://localhost/rssify")).toThrow(
      /protocol/
    )
  })
})
