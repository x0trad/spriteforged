// PixelLab bridge — generate characters and animations with PixelLab's API (https://api.pixellab.ai/v2)
// and land the frames as Sprite Forge sprites.
//
// Token: set PIXELLAB_TOKEN (or PIXELLAB_API_KEY) in the server's environment. It is never taken from tool
// arguments, so it never passes through chat.
//
// Flow: create-character-v3 / characters/animations start background jobs → we poll
// /background-jobs/{id} → GET /characters/{id} lists rotation_urls and animation frame URLs →
// each PNG is decoded with F.importPNG into the sprite's palette.
// The sprite keeps a `pixellab` block (character id, pending jobs, what has been imported) so
// pixellab_sync can finish the import later if a job outlives the tool call.

import { PNG } from "pngjs";
import * as F from "./format.js";

export const DIRECTIONS_8 = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"];

export function pixellabClient({ token, base, fetchImpl } = {}) {
  token = token ?? (process.env.PIXELLAB_TOKEN || process.env.PIXELLAB_API_KEY || "");
  base = (base ?? process.env.PIXELLAB_API_BASE ?? "https://api.pixellab.ai/v2").replace(/\/$/, "");
  const doFetch = fetchImpl || fetch;

  function need() {
    if (!token) throw new Error("PixelLab isn't set up: add PIXELLAB_TOKEN to this MCP server's environment (token from pixellab.ai/account), then restart the server.");
  }
  async function call(method, path, body) {
    need();
    const r = await doFetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const txt = await r.text();
    let data; try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
    if (!r.ok) {
      const d = data.detail;
      const msg = typeof d === "string" ? d : d ? JSON.stringify(d) : txt.slice(0, 300);
      const hint = r.status === 401 ? " (check PIXELLAB_TOKEN)" : r.status === 402 ? " (out of PixelLab credits)" : r.status === 429 ? " (rate limited, try again shortly)" : "";
      throw new Error(`PixelLab ${method} ${path} → ${r.status}: ${msg}${hint}`);
    }
    return data;
  }
  async function download(url) {
    const abs = /^https?:\/\//.test(url) ? url : new URL(url, base + "/").href;
    let r = await doFetch(abs);
    if ((r.status === 401 || r.status === 403) && abs.startsWith(base)) r = await doFetch(abs, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Download ${abs} → ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  function decodeImage(src) {
    if (typeof src === "string" && src.startsWith("data:")) return Buffer.from(src.split(",")[1], "base64");
    if (src && typeof src === "object" && src.base64) return Buffer.from(String(src.base64).replace(/^data:[^,]+,/, ""), "base64");
    return null;
  }
  async function image(src) { return decodeImage(src) || download(src); }

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  /** Poll background jobs until all finish or `budgetMs` runs out. Returns { done, failed:[{id,detail}], pending:[ids] }. */
  async function waitJobs(ids, budgetMs, intervalMs = Number(process.env.PIXELLAB_POLL_MS) || 4000) {
    const end = Date.now() + budgetMs;
    let pending = [...ids];
    const failed = [];
    while (pending.length) {
      const next = [];
      for (const id of pending) {
        const j = await call("GET", `/background-jobs/${id}`);
        const st = String(j.status || "").toLowerCase();
        if (st === "completed" || st === "complete" || st === "succeeded") continue;
        if (st === "failed" || st === "error" || st === "cancelled" || st === "canceled") { failed.push({ id, detail: j.last_response?.detail || st }); continue; }
        next.push(id);
      }
      pending = next;
      if (!pending.length || Date.now() + intervalMs > end) break;
      await sleep(intervalMs);
    }
    return { done: !pending.length && !failed.length, failed, pending };
  }

  return { call, image, waitJobs, base, hasToken: () => !!token };
}

/** Decode one PNG into a frame of the sprite, sizing a brand-new sprite to the first image. */
export function framesFromPNG(s, buf) {
  const png = PNG.sync.read(buf);
  if (s.pixellab && s.pixellab.sized === false) {
    // First image from PixelLab decides the canvas (it can be larger than the requested character size).
    s.width = png.width; s.height = png.height; s.pixellab.sized = true;
    for (const a of s.animations) for (const f of a.frames) f.rows = F.blankRows(s.width, s.height);
  }
  if (png.width !== s.width || png.height !== s.height) {
    // Centre-pad or crop to the sprite's size so mismatched canvases still line up on the feet.
    const out = new PNG({ width: s.width, height: s.height });
    const dx = Math.floor((s.width - png.width) / 2), dy = s.height - png.height;
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      const tx = x + dx, ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= s.width || ty >= s.height) continue;
      png.data.copy(out.data, (ty * s.width + tx) * 4, (y * png.width + x) * 4, (y * png.width + x) * 4 + 4);
    }
    buf = PNG.sync.write(out);
  }
  return F.importPNG(s, buf, s.width, s.height)[0];
}

const slug = (t) => String(t || "anim").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "anim";

/**
 * Pull everything PixelLab has for the sprite's character that isn't in the sprite yet.
 * Rotations → animation "rotations" (one frame per direction, south first, clockwise as PixelLab orders them)
 *             plus "idle" set to the facing in s.pixellab.facing.
 * Each animation group/direction → animation "<name>" (one direction) or "<name>-<direction>".
 */
export async function syncCharacter(pl, s) {
  const meta = s.pixellab;
  if (!meta?.character_id) throw new Error(`Sprite "${s.id}" isn't linked to a PixelLab character. Use pixellab_create_character first.`);
  const c = await pl.call("GET", `/characters/${meta.character_id}`);
  meta.imported ||= [];
  const added = [];

  if (c.rotation_urls && !meta.imported.includes("rotations")) {
    const dirs = DIRECTIONS_8.filter((d) => c.rotation_urls[d]);
    if (dirs.length) {
      const frames = [];
      for (const d of dirs) frames.push(framesFromPNG(s, await pl.image(c.rotation_urls[d])));
      s.animations = s.animations.filter((a) => a.name !== "rotations");
      s.animations.push({ name: "rotations", fps: 4, loop: true, frames, directions: dirs });
      const face = dirs.includes(meta.facing) ? meta.facing : dirs.includes("east") ? "east" : dirs[0];
      const idle = s.animations.find((a) => a.name === "idle");
      const still = { ...frames[dirs.indexOf(face)], hitboxes: [] };
      if (idle && idle.frames.every((f) => f.rows.every((r) => /^\.*$/.test(r)))) idle.frames = [still];
      else if (!idle) s.animations.unshift({ name: "idle", fps: 8, loop: true, frames: [still] });
      meta.imported.push("rotations");
      added.push(`rotations (${dirs.join(", ")})`);
    }
  }

  for (const g of c.animations || []) {
    const gid = g.animation_group_id || g.animation_type;
    const base = slug(meta.names?.[gid] || g.display_name || g.animation_type);
    const many = (g.directions || []).length > 1;
    for (const d of g.directions || []) {
      const key = `${gid}:${d.direction}`;
      if (meta.imported.includes(key) || !d.frames?.length) continue;
      const name = many ? `${base}-${d.direction}` : base;
      const frames = [];
      for (const url of d.frames) frames.push(framesFromPNG(s, await pl.image(url)));
      s.animations = s.animations.filter((a) => a.name !== name);
      s.animations.push({ name, fps: 10, loop: true, frames, pixellab: { group: gid, direction: d.direction } });
      meta.imported.push(key);
      added.push(`${name} (${frames.length} frames)`);
    }
  }
  return { added, character: { id: c.id, name: c.name, size: c.size, directions: c.directions, animations: (c.animations || []).length } };
}
