import { expect, test } from "bun:test"

import { answerJwksInProcess } from "@/test/jwks"
import { mintMcpToken } from "@/test/mcp-token"

import { withMcpAuth } from "./actor"
import { MCP_RESOURCE } from "./auth"
import { db } from "./db"
import { disconnectApp, listConnectedApps } from "./mcp-clients"

answerJwksInProcess()

test("disconnect preserves the issued access token until expiry but removes the app from Settings", async () => {
  const issued = await mintMcpToken("disconnect-user")
  const route = withMcpAuth(async (_request, actor) => Response.json(actor))
  const request = () =>
    new Request(MCP_RESOURCE, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.access_token}` },
    })
  expect((await route(request())).status).toBe(200)
  expect(await disconnectApp("disconnect-user", issued.clientId)).toEqual({
    ok: true,
  })
  expect(await listConnectedApps("disconnect-user")).toEqual([])
  const response = await route(request())
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    userId: "disconnect-user",
    isAdmin: false,
  })
})

test("repeated disconnect returns not_found and preserves the original revocation time", async () => {
  const issued = await mintMcpToken("repeat-user")
  await disconnectApp("repeat-user", issued.clientId)
  const first = await db.oauthRefreshToken.findFirstOrThrow({
    where: { userId: "repeat-user", clientId: issued.clientId },
  })
  expect(first.revoked).toBeInstanceOf(Date)
  expect(await disconnectApp("repeat-user", issued.clientId)).toEqual({
    ok: false,
    code: "not_found",
  })
  const again = await db.oauthRefreshToken.findUniqueOrThrow({
    where: { id: first.id },
  })
  expect(again.revoked).toEqual(first.revoked)
})

test("equal connection times have stable ordering, and merely owning a client does not list it", async () => {
  const now = new Date("2026-10-22T00:00:00Z")
  await db.user.create({
    data: { id: "list-user", name: "Reader", email: "list@example.invalid" },
  })
  for (const id of ["a", "z", "unconsented"]) {
    const clientId = `https://${id}.example.invalid/client.json`
    await db.oauthClient.create({ data: { id, clientId, userId: "list-user" } })
    if (id !== "unconsented")
      await db.oauthConsent.create({
        data: {
          id,
          clientId,
          userId: "list-user",
          createdAt: now,
          updatedAt: now,
          scopes: ["reader"],
        },
      })
  }
  const apps = await listConnectedApps("list-user")
  expect(apps.map((app) => app.name)).toEqual([
    "z.example.invalid",
    "a.example.invalid",
  ])
  expect(apps.map((app) => app.host)).toEqual([
    "z.example.invalid",
    "a.example.invalid",
  ])
})
