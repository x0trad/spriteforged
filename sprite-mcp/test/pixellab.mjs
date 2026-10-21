// PixelLab bridge test against a local mock of api.pixellab.ai/v2 (no token or credits needed).
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PNG } from "pngjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const W = 92, H = 92; // PixelLab canvases are often bigger than the requested size
function pic(color, shift = 0) {
  const p = new PNG({ width: W, height: H });
  for (let y = 30; y < 80; y++) for (let x = 30 + shift; x < 60 + shift; x++) {
    const o = (y * W + x) * 4; p.data[o] = color[0]; p.data[o + 1] = color[1]; p.data[o + 2] = color[2]; p.data[o + 3] = 255;
  }
  return PNG.sync.write(p);
}
const dirs = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"];
const seen = { auth: [], bodies: [] };
const jobs = {}; let anim = null;
const srv = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let body = ""; for await (const c of req) body += c;
  const json = (o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (url.pathname.startsWith("/img/")) { const [, , d, i] = url.pathname.split("/"); res.writeHead(200, { "content-type": "image/png" }); return res.end(pic(d === "anim" ? [240, 86, 79] : [245, 166, 35], Number(i || 0))); }
  seen.auth.push(req.headers.authorization);
  if (req.headers.authorization !== "Bearer test-token") return json({ detail: "Invalid API token" }, 401);
  if (body) seen.bodies.push({ path: url.pathname, body: JSON.parse(body) });
  if (url.pathname === "/v2/balance") return json({ credits: { type: "usd", usd: 1.5 }, subscription: { type: "generations", status: "active", plan: "test", generations: 10, total: 2000 } });
  if (url.pathname === "/v2/create-character-v3") { jobs.j1 = 0; return json({ background_job_id: "j1", character_id: "c1", status: "processing" }); }
  if (url.pathname === "/v2/characters/animations") { jobs.j2 = 0; anim = JSON.parse(body); return json({ background_job_ids: ["j2"], animation_group_id: "g1", directions: anim.directions, status: "processing" }); }
  const jm = url.pathname.match(/^\/v2\/background-jobs\/(\w+)$/);
  if (jm) { jobs[jm[1]]++; return json({ id: jm[1], status: jobs[jm[1]] >= 2 ? "completed" : "processing", created_at: "now", last_response: null }); }
  if (url.pathname === "/v2/characters/c1") return json({
    id: "c1", name: "rider", prompt: "x", size: { width: 64, height: 64 }, directions: 8, created_at: "now", animation_count: anim ? 1 : 0, template_id: "mannequin",
    rotation_urls: Object.fromEntries(dirs.map((d) => [d, `/img/rot/0?d=${d}`])),
    animations: anim ? [{ animation_type: "custom", display_name: anim.animation_name, animation_group_id: "g1", directions: anim.directions.map((d) => ({ direction: d, frame_count: 4, frames: [0, 2, 4, 6].map((i) => `/img/anim/${i}`) })) }] : [],
  });
  json({ detail: "not found " + url.pathname }, 404);
});
await new Promise((r) => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}/v2`;

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sprite-mcp-pl-"));
const client = new Client({ name: "pl-test", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/server.js", import.meta.url).pathname], env: { ...process.env, SPRITES_DIR: dir, PIXELLAB_API_BASE: base, PIXELLAB_TOKEN: "test-token", PIXELLAB_POLL_MS: "50" } }));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); if (r.isError) throw new Error(`${name}: ${r.content[0].text}`); return r; };
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };

const names = (await client.listTools()).tools.map((t) => t.name);
assert(["pixellab_balance", "pixellab_create_character", "pixellab_animate", "pixellab_sync"].every((n) => names.includes(n)), "tools registered");
const bal = await call("pixellab_balance", {});
assert(bal.content[0].text.includes("generations"), "balance");

// Wait 0 → returns processing, then sync finishes it.
let r = await call("pixellab_create_character", { id: "rider", description: "delivery rider on a kapchai", size: 64, wait_seconds: 0 });
assert(r.content[0].text.includes("processing"), "create returns processing with wait 0");
r = await call("pixellab_sync", { id: "rider", wait_seconds: 5 });
assert(r.content.some((c) => c.type === "image"), "sync returns preview");
let s = JSON.parse(await fs.readFile(path.join(dir, "rider.sprite.json"), "utf8"));
assert(s.width === W && s.height === H, `sprite resized to PixelLab canvas (${s.width}x${s.height})`);
const rot = s.animations.find((a) => a.name === "rotations");
assert(rot && rot.frames.length === 8, "8 rotation frames");
const idle = s.animations.find((a) => a.name === "idle");
assert(idle.frames[0].rows.some((row) => /[^.]/.test(row)), "idle filled from facing view");
assert(s.pixellab.character_id === "c1" && s.pixellab.jobs.length === 0, "meta kept");
assert(seen.bodies[0].body.view === "side" && seen.bodies[0].body.n_directions === 8, "create body");

r = await call("pixellab_animate", { id: "rider", action: "riding motorbike", name: "ride", frame_count: 4, wait_seconds: 5 });
s = JSON.parse(await fs.readFile(path.join(dir, "rider.sprite.json"), "utf8"));
const ride = s.animations.find((a) => a.name === "ride");
assert(ride && ride.frames.length === 4, "ride animation imported with 4 frames");
assert(ride.frames[0].rows.join() !== ride.frames[2].rows.join(), "frames differ");
assert(seen.bodies.at(-1).body.directions[0] === "east" && seen.bodies.at(-1).body.mode === "v3", "animate body defaults");
// Sync again imports nothing new.
r = await call("pixellab_sync", { id: "rider", wait_seconds: 0 });
assert(r.content[1] && JSON.parse(r.content[0].text).imported.length === 0, "re-sync is idempotent");
// The sprite still works with the normal tools.
await call("export_sheet", { id: "rider" });
const sheet = PNG.sync.read(await fs.readFile(path.join(dir, "rider.png")));
assert(sheet.width >= W * 8, "sheet exported");

// Missing token gives a clear error.
const c2 = new Client({ name: "pl-test2", version: "1" });
const env2 = { ...process.env, SPRITES_DIR: dir, PIXELLAB_API_BASE: base }; delete env2.PIXELLAB_TOKEN; delete env2.PIXELLAB_API_KEY;
await c2.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/server.js", import.meta.url).pathname], env: env2 }));
const e = await c2.callTool({ name: "pixellab_balance", arguments: {} });
assert(e.isError && e.content[0].text.includes("PIXELLAB_TOKEN"), "missing token message");
assert(!JSON.stringify(s).includes("test-token"), "token never written to sprite file");

console.log("PASS pixellab bridge — sprite", s.width + "x" + s.height, "animations:", s.animations.map((a) => `${a.name}(${a.frames.length})`).join(", "));
await client.close(); await c2.close(); srv.close();
