// End-to-end smoke test: spawns the server over stdio and drives it with the MCP client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sprite-mcp-"));
const transport = new StdioClientTransport({ command: "node", args: [new URL("../src/server.js", import.meta.url).pathname], env: { ...process.env, SPRITES_DIR: dir } });
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return r;
};

await call("create_sprite", { id: "test-dog", name: "Test Dog", width: 16, height: 16 });
await call("draw", { id: "test-dog", mirror: true, ops: [
  { op: "ellipse", cx: 7.5, cy: 6, rx: 5, ry: 4, color: "#000000", fill: true },
  { op: "ellipse", cx: 7.5, cy: 6, rx: 4, ry: 3, color: "#f5a623", fill: true },
  { op: "pixel", x: 5, y: 5, color: "#ffffff" },
  { op: "rect", x: 5, y: 10, w: 6, h: 5, color: "#000000", fill: true },
  { op: "line", x0: 2, y0: 2, x1: 4, y1: 4, color: "#000000" },
]});
const f = await call("get_frame", { id: "test-dog", scale: 4 });
console.log(f.content[0].text);
if (!f.content.find((c) => c.type === "image")) throw new Error("no image returned");
await call("edit_frames", { id: "test-dog", action: "duplicate", frame: 0 });
await call("edit_frames", { id: "test-dog", action: "shift", frame: 1, dx: 0, dy: -1 });
await call("set_hitboxes", { id: "test-dog", frame: 0, hitboxes: [{ kind: "hurt", x: 3, y: 2, w: 10, h: 13 }] });
await call("edit_animation", { id: "test-dog", animation: "punch", action: "create", copyFrom: "idle", fps: 12, loop: false });
await call("set_frame", { id: "test-dog", animation: "punch", frame: 2, rows: ["0000", ".11.", ".11.", "0000"] });
const sheet = await call("export_sheet", { id: "test-dog" });
console.log(sheet.content[0].text);
await call("import_png", { id: "reimport", file: path.join(dir, "test-dog.png"), frameWidth: 16, frameHeight: 16 });
const list = await call("list_sprites", {});
console.log(list.content[0].text);
const bad = await client.callTool({ name: "get_frame", arguments: { id: "nope" } });
if (!bad.isError) throw new Error("expected error for missing sprite");
console.log("error path ok:", bad.content[0].text);
await fs.writeFile(path.join(dir, "preview.png"), Buffer.from(f.content.find((c) => c.type === "image").data, "base64"));
console.log("PASS — files in", dir);
await client.close();
