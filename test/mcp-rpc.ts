// One JSON-RPC exchange with an MCP handler in process, in either protocol
// era, so tests read results instead of wire framing.

export const MCP_URL = "http://localhost:3210/api/mcp"
export const LEGACY_VERSION = "2025-06-18"
export const MODERN_VERSION = "2026-07-28"

export type Era = "legacy" | "modern"

type Fetch = (request: Request) => Promise<Response>

export function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  { era = "modern", headers = {} }: { era?: Era; headers?: HeadersInit } = {}
) {
  const all = new Headers(headers)
  all.set("content-type", "application/json")
  all.set("accept", "application/json, text/event-stream")
  let body: Record<string, unknown> = { jsonrpc: "2.0", id: 1, method, params }
  if (era === "modern") {
    all.set("mcp-protocol-version", MODERN_VERSION)
    all.set("mcp-method", method)
    if (typeof params.name === "string") all.set("mcp-name", params.name)
    body = {
      ...body,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }
  } else if (method !== "initialize") {
    all.set("mcp-protocol-version", LEGACY_VERSION)
  }
  return new Request(MCP_URL, {
    method: "POST",
    headers: all,
    body: JSON.stringify(body),
  })
}

// The legacy leg answers as one SSE message, the modern one as JSON.
export async function readRpc(response: Response) {
  const text = await response.text()
  const data = response.headers.get("content-type")?.includes("event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : text
  return JSON.parse(data ?? "null")
}

export async function rpc(
  fetch: Fetch,
  method: string,
  params?: Record<string, unknown>,
  options?: { era?: Era; headers?: HeadersInit }
) {
  const response = await fetch(mcpRequest(method, params, options))
  return { status: response.status, body: await readRpc(response) }
}

export type ToolResult = {
  isError?: boolean
  structuredContent?: Record<string, unknown>
  content: { type: string; text: string }[]
}

export async function callTool(
  fetch: Fetch,
  name: string,
  args: Record<string, unknown> = {},
  options?: { era?: Era; headers?: HeadersInit }
): Promise<ToolResult> {
  const { body } = await rpc(
    fetch,
    "tools/call",
    { name, arguments: args },
    options
  )
  if (!body?.result) throw new Error(`no result: ${JSON.stringify(body)}`)
  return body.result
}
