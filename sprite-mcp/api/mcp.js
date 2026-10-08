// sprite-mcp (cloud, Streamable HTTP) — one Vercel function serving MCP at /mcp/<key>.
// Stateless: a fresh server + transport per request, sprites persisted in Vercel Blob.
import { readFileSync } from "node:fs";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "../src/tools.js";
import { blobStore, tmpStore } from "../src/store.js";

let fileKey = "";
try { fileKey = JSON.parse(readFileSync(new URL("../mcp.config.json", import.meta.url), "utf8")).key || ""; } catch {}
const KEY = process.env.MCP_KEY || fileKey;
const store = process.env.BLOB_READ_WRITE_TOKEN ? blobStore() : tmpStore();

async function handle(request) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key) {
    return Response.json({ name: "sprite-mcp", transport: "streamable-http", endpoint: "/mcp/<key>", storage: store.kind, persistent: store.kind === "blob" });
  }
  if (!KEY || key !== KEY) return new Response("Unauthorized: wrong key", { status: 401 });
  const server = buildServer(store);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
