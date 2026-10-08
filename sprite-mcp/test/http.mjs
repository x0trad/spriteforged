// Local test of the cloud handler: serve api/mcp.js over node:http, drive it with the MCP HTTP client.
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const { POST } = await import("../api/mcp.js");
const key = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../mcp.config.json", import.meta.url), "utf8")).key;
const srv = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const u = new URL(req.url, "http://x"); const m = u.pathname.match(/^\/mcp\/(.+)$/);
  const url = m ? `http://x/api/mcp?key=${m[1]}` : "http://x/api/mcp";
  const r = await POST(new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(0);
const port = srv.address().port;
console.log("no key:", (await fetch(`http://127.0.0.1:${port}/api/mcp`)).status, "bad key:", (await fetch(`http://127.0.0.1:${port}/mcp/nope`, { method: "POST" })).status);
const client = new Client({ name: "t", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${key}`)));
console.log("tools:", (await client.listTools()).tools.length);
const call = async (n, a) => { const r = await client.callTool({ name: n, arguments: a }); if (r.isError) throw new Error(r.content[0].text); return r; };
try { await call("delete_sprite", { id: "http-dog" }); } catch {}
await call("create_sprite", { id: "http-dog", width: 16, height: 16 });
await call("draw", { id: "http-dog", mirror: true, ops: [{ op: "ellipse", cx: 7.5, cy: 8, rx: 5, ry: 6, color: "#f5a623", fill: true }] });
const f = await call("get_frame", { id: "http-dog" });
console.log(f.content[0].text.split("\n").slice(1, 5).join("\n"));
console.log((await call("export_sheet", { id: "http-dog" })).content[0].text);
await client.close(); srv.close(); console.log("HTTP PASS");
