// Store-agnostic tool registration — used by the stdio server (local files) and the HTTP server (Vercel Blob).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import * as F from "./format.js";

export function buildServer(store) {
  const server = new McpServer({ name: "sprite-mcp", version: "1.1.0" });
  async function load(id) {
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) throw new Error(`Bad sprite id "${id}" (use letters, digits, - and _)`);
    const raw = await store.read(id);
    if (!raw) throw new Error(`No sprite "${id}" in ${store.location}. Use list_sprites or create_sprite.`);
    const s = F.normalize(raw);
    s.id = id;
    return s;
  }
  async function save(s) { F.touch(s); await store.write(s.id, s); }

// ---------- helpers ----------
  const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 1) }] });
  const image = (buf, caption) => ({ content: [{ type: "text", text: caption }, { type: "image", data: buf.toString("base64"), mimeType: "image/png" }] });
  const fail = (e) => ({ isError: true, content: [{ type: "text", text: "Error: " + (e.message || e) }] });
  const wrap = (fn) => async (args) => { try { return await fn(args); } catch (e) { return fail(e); } };
  function summary(s) {
    return {
      id: s.id, name: s.name, size: `${s.width}x${s.height}`,
      palette: s.palette.map((c, i) => `${F.iChr(i)}=${c}`),
      animations: s.animations.map((a) => ({ name: a.name, fps: a.fps, loop: a.loop, frames: a.frames.length })),
    };
  }
  function frameText(s, animName, index) {
    const f = F.getFrame(s, animName, index);
    return `sprite ${s.id} · ${animName} #${index} · ${s.width}x${s.height} · palette ${s.palette.map((c, i) => `${F.iChr(i)}=${c}`).join(" ")}\n` +
      f.rows.join("\n") + `\nhitboxes: ${JSON.stringify(f.hitboxes)}`;
  }
  async function previewAfter(s, animName, index, scale) {
    const f = F.getFrame(s, animName, index);
    return image(F.renderFramePNG(s, f, scale), frameText(s, animName, index));
  }
  const Color = z.union([z.string(), z.number()]).describe('Colour: "#rrggbb" (added to the palette if new), a palette character, or "." for transparent');
  
  // ---------- server ----------
  
  
  server.registerTool("list_sprites", {
    description: `List sprites in storage (${store.location}). Returns id, name, size and animations for each.`,
    inputSchema: {},
  }, wrap(async () => {
    const out = [];
    for (const id of await store.list()) { try { out.push(summary(await load(id))); } catch {} }
    return text(out.length ? out : `No sprites yet in ${store.location}. Use create_sprite.`);
  }));
  
  server.registerTool("create_sprite", {
    description: "Create a new sprite with an empty 'idle' animation of one blank frame. Palette colours are '#rrggbb'; index 0 is written as '0', index 10 as 'a', etc.",
    inputSchema: {
      id: z.string().describe("Slug used as the file name, e.g. 'dog-red'"),
      name: z.string().optional(),
      width: z.number().int().min(4).max(128).default(32),
      height: z.number().int().min(4).max(128).default(32),
      palette: z.array(z.string()).optional().describe("Optional starting palette, up to 62 '#rrggbb' colours"),
    },
  }, wrap(async ({ id, name, width, height, palette }) => {
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) throw new Error(`Bad sprite id "${id}" (use letters, digits, - and _)`);
    if (await store.read(id)) throw new Error(`Sprite "${id}" already exists`);
    const s = F.newSprite({ id, name, width, height, palette: palette?.map((c) => c.toLowerCase()) });
    await save(s);
    return text(summary(s));
  }));
  
  server.registerTool("get_sprite", {
    description: "Get a sprite's full document: palette, animations and every frame as text rows ('.' = transparent, other chars index the palette).",
    inputSchema: { id: z.string() },
  }, wrap(async ({ id }) => text(await load(id))));
  
  server.registerTool("get_frame", {
    description: "Show one frame as text rows plus a rendered PNG preview. Use this to see what you drew.",
    inputSchema: { id: z.string(), animation: z.string().default("idle"), frame: z.number().int().default(0), scale: z.number().int().min(1).max(16).default(8) },
  }, wrap(async ({ id, animation, frame, scale }) => previewAfter(await load(id), animation, frame, scale)));
  
  server.registerTool("set_frame", {
    description: "Replace a frame's pixels with text rows. Provide exactly `height` strings of `width` characters ('.' transparent, other characters index the palette in order 0-9a-zA-Z). Short rows are padded. Creates the animation / appends the frame if the index is past the end.",
    inputSchema: {
      id: z.string(), animation: z.string().default("idle"), frame: z.number().int().default(0),
      rows: z.array(z.string()),
      palette: z.array(z.string()).optional().describe("Optional: replace the whole palette first (list of '#rrggbb')"),
    },
  }, wrap(async ({ id, animation, frame, rows, palette }) => {
    const s = await load(id);
    if (palette) s.palette = palette.slice(0, F.ALPHA.length).map((c) => c.toLowerCase());
    let a = s.animations.find((x) => x.name === animation);
    if (!a) { a = { name: animation, fps: 8, loop: true, frames: [] }; s.animations.push(a); }
    while (a.frames.length <= frame) a.frames.push({ rows: F.blankRows(s.width, s.height), duration: 1, hitboxes: [] });
    const f = a.frames[frame];
    f.rows = Array.from({ length: s.height }, (_, y) => String(rows[y] || "").padEnd(s.width, F.T).slice(0, s.width));
    const bad = new Set();
    for (const r of f.rows) for (const ch of r) if (ch !== F.T && (F.cIdx(ch) < 0 || F.cIdx(ch) >= s.palette.length)) bad.add(ch);
    if (bad.size) throw new Error(`Characters not in palette: ${[...bad].join(" ")} (palette has ${s.palette.length} colours: ${s.palette.map((_, i) => F.iChr(i)).join("")})`);
    await save(s);
    return previewAfter(s, animation, frame, 8);
  }));
  
  server.registerTool("draw", {
    description: "Apply drawing operations to a frame, in order. Ops: pixel{x,y}, line{x0,y0,x1,y1}, rect{x,y,w,h,fill?}, ellipse{cx,cy,rx,ry,fill?}, fill{x,y} (flood), replace{from,to}. Each op takes `color`. Set mirror:true to mirror every op across the vertical centre (handy for symmetrical characters). Returns the updated frame as text + PNG.",
    inputSchema: {
      id: z.string(), animation: z.string().default("idle"), frame: z.number().int().default(0),
      mirror: z.boolean().default(false),
      ops: z.array(z.object({
        op: z.enum(["pixel", "line", "rect", "ellipse", "fill", "replace"]),
        color: Color.optional(),
        x: z.number().optional(), y: z.number().optional(),
        x0: z.number().optional(), y0: z.number().optional(), x1: z.number().optional(), y1: z.number().optional(),
        w: z.number().optional(), h: z.number().optional(),
        cx: z.number().optional(), cy: z.number().optional(), rx: z.number().optional(), ry: z.number().optional(),
        fill: z.boolean().optional(),
        from: Color.optional(), to: Color.optional(),
      })).min(1),
    },
  }, wrap(async ({ id, animation, frame, mirror, ops }) => {
    const s = await load(id);
    const f = F.getFrame(s, animation, frame);
    const g = F.grid(f);
    for (const o of ops) {
      const c = F.colorChar(s, o.color);
      switch (o.op) {
        case "pixel": F.setPx(g, o.x | 0, o.y | 0, c, s, mirror); break;
        case "line": F.line(g, o.x0 | 0, o.y0 | 0, o.x1 | 0, o.y1 | 0, c, s, mirror); break;
        case "rect": F.rect(g, o.x | 0, o.y | 0, o.w | 0, o.h | 0, c, s, !!o.fill, mirror); break;
        case "ellipse": F.ellipse(g, o.cx, o.cy, o.rx, o.ry, c, s, !!o.fill, mirror); break;
        case "fill": F.fill(g, o.x | 0, o.y | 0, c, s); break;
        case "replace": F.replaceColor(g, F.colorChar(s, o.from), F.colorChar(s, o.to), s); break;
      }
    }
    F.ungrid(f, g);
    await save(s);
    return previewAfter(s, animation, frame, 8);
  }));
  
  server.registerTool("edit_frames", {
    description: "Frame management: add (blank), duplicate, delete, move, shift (dx,dy), flip_x, set_duration. Index refers to the frame acted on; `to` is the destination index for move.",
    inputSchema: {
      id: z.string(), animation: z.string().default("idle"),
      action: z.enum(["add", "duplicate", "delete", "move", "shift", "flip_x", "set_duration"]),
      frame: z.number().int().optional(), to: z.number().int().optional(),
      dx: z.number().int().optional(), dy: z.number().int().optional(), duration: z.number().int().min(1).optional(),
    },
  }, wrap(async ({ id, animation, action, frame, to, dx, dy, duration }) => {
    const s = await load(id);
    const a = F.findAnim(s, animation);
    const i = frame ?? a.frames.length - 1;
    switch (action) {
      case "add": a.frames.splice((frame ?? a.frames.length - 1) + 1, 0, { rows: F.blankRows(s.width, s.height), duration: 1, hitboxes: [] }); break;
      case "duplicate": a.frames.splice(i + 1, 0, JSON.parse(JSON.stringify(F.getFrame(s, animation, i)))); break;
      case "delete": F.getFrame(s, animation, i); if (a.frames.length === 1) throw new Error("An animation needs at least one frame"); a.frames.splice(i, 1); break;
      case "move": { const f = F.getFrame(s, animation, i); a.frames.splice(i, 1); a.frames.splice(Math.max(0, Math.min(to ?? 0, a.frames.length)), 0, f); break; }
      case "shift": F.shift(F.getFrame(s, animation, i), dx || 0, dy || 0, s); break;
      case "flip_x": F.flipX(F.getFrame(s, animation, i), s); break;
      case "set_duration": F.getFrame(s, animation, i).duration = duration || 1; break;
    }
    await save(s);
    return text({ ok: true, animation: a.name, frames: a.frames.length, durations: a.frames.map((f) => f.duration) });
  }));
  
  server.registerTool("edit_animation", {
    description: "Create, rename, delete or configure an animation (fps, loop).",
    inputSchema: {
      id: z.string(), animation: z.string(),
      action: z.enum(["create", "rename", "delete", "configure"]),
      newName: z.string().optional(), fps: z.number().min(1).max(60).optional(), loop: z.boolean().optional(),
      copyFrom: z.string().optional().describe("For create: copy frames from this animation"),
    },
  }, wrap(async ({ id, animation, action, newName, fps, loop, copyFrom }) => {
    const s = await load(id);
    if (action === "create") {
      if (s.animations.some((x) => x.name === animation)) throw new Error(`Animation "${animation}" exists`);
      const frames = copyFrom ? JSON.parse(JSON.stringify(F.findAnim(s, copyFrom).frames)) : [{ rows: F.blankRows(s.width, s.height), duration: 1, hitboxes: [] }];
      s.animations.push({ name: animation, fps: fps || 8, loop: loop !== false, frames });
    } else {
      const a = F.findAnim(s, animation);
      if (action === "rename") a.name = newName || a.name;
      if (action === "delete") { if (s.animations.length === 1) throw new Error("A sprite needs at least one animation"); s.animations.splice(s.animations.indexOf(a), 1); }
      if (action === "configure") { if (fps) a.fps = fps; if (loop !== undefined) a.loop = loop; }
    }
    await save(s);
    return text(summary(s));
  }));
  
  server.registerTool("set_hitboxes", {
    description: "Replace a frame's hitboxes. kind 'hurt' = where the character can be hit, 'hit' = where an attack lands. Coordinates in sprite pixels.",
    inputSchema: {
      id: z.string(), animation: z.string().default("idle"), frame: z.number().int().default(0),
      hitboxes: z.array(z.object({ kind: z.enum(["hurt", "hit"]), x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) })),
    },
  }, wrap(async ({ id, animation, frame, hitboxes }) => {
    const s = await load(id);
    F.getFrame(s, animation, frame).hitboxes = hitboxes;
    await save(s);
    return previewAfter(s, animation, frame, 8);
  }));
  
  server.registerTool("set_palette", {
    description: "Edit the palette: set a colour at an index, add colours, or remove an index (pixels using it become transparent).",
    inputSchema: {
      id: z.string(),
      set: z.array(z.object({ index: z.number().int().min(0).max(61), color: z.string() })).optional(),
      add: z.array(z.string()).optional(),
      remove: z.number().int().optional(),
    },
  }, wrap(async ({ id, set, add, remove }) => {
    const s = await load(id);
    for (const { index, color } of set || []) { while (s.palette.length <= index) s.palette.push("#000000"); s.palette[index] = color.toLowerCase(); }
    for (const c of add || []) { if (s.palette.length >= F.ALPHA.length) throw new Error("Palette full"); s.palette.push(c.toLowerCase()); }
    if (remove !== undefined) {
      if (remove >= s.palette.length) throw new Error("Index out of range");
      s.palette.splice(remove, 1);
      for (const a of s.animations) for (const f of a.frames)
        f.rows = f.rows.map((r) => r.split("").map((ch) => { const j = F.cIdx(ch); return j === remove ? F.T : j > remove ? F.iChr(j - 1) : ch; }).join(""));
    }
    await save(s);
    return text(summary(s).palette);
  }));
  
  server.registerTool("export_sheet", {
    description: "Render a sprite sheet PNG (one row per animation) and a JSON atlas (Aseprite-style frames + frameTags + hitboxes) next to the sprite file. Returns the file paths and a preview.",
    inputSchema: { id: z.string(), outDir: z.string().optional().describe("Local mode only: output folder (defaults to the sprite folder)") },
  }, wrap(async ({ id, outDir }) => {
    const s = await load(id);
    const { png, meta } = F.renderSheet(s);
    const p1 = await store.putFile(`${id}.png`, png, "image/png", outDir);
    const p2 = await store.putFile(`${id}.atlas.json`, Buffer.from(JSON.stringify(meta, null, 1)), "application/json", outDir);
    return image(png, `Wrote ${p1} (${meta.meta.size.w}x${meta.meta.size.h}) and ${p2}`);
  }));
  
  server.registerTool("import_png", {
    description: "Import a PNG (single image or a sheet sliced into frameWidth×frameHeight tiles, left→right, top→bottom) into an animation. Give a local file path, an https URL, or base64 PNG data. Creates the sprite if it doesn't exist.",
    inputSchema: { id: z.string(), file: z.string().describe("Local path, https:// URL, or base64-encoded PNG"), animation: z.string().default("import"), frameWidth: z.number().int().optional(), frameHeight: z.number().int().optional() },
  }, wrap(async ({ id, file, animation, frameWidth, frameHeight }) => {
    let buf;
    if (/^https?:\/\//.test(file)) buf = Buffer.from(await (await fetch(file)).arrayBuffer());
    else if (/^data:image\/png;base64,/.test(file) || (file.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(file))) buf = Buffer.from(file.replace(/^data:image\/png;base64,/, ""), "base64");
    else buf = await fs.readFile(path.resolve(file));
    let s;
    try { s = await load(id); } catch { s = null; }
    const fw = frameWidth || s?.width, fh = frameHeight || s?.height;
    if (!fw || !fh) throw new Error("Give frameWidth/frameHeight when the sprite doesn't exist yet");
    if (!s) { s = F.newSprite({ id, width: fw, height: fh, palette: [] }); s.palette = []; s.animations = []; }
    else if (s.width !== fw || s.height !== fh) throw new Error(`Sprite is ${s.width}x${s.height}; frames must match`);
    const frames = F.importPNG(s, buf, fw, fh);
    let a = s.animations.find((x) => x.name === animation);
    if (!a) { a = { name: animation, fps: 8, loop: true, frames: [] }; s.animations.push(a); }
    a.frames.push(...frames);
    await save(s);
    return text({ imported: frames.length, ...summary(s) });
  }));
  
  server.registerTool("delete_sprite", {
    description: "Delete a sprite file permanently.",
    inputSchema: { id: z.string() },
  }, wrap(async ({ id }) => { await load(id); await store.remove(id); return text(`Deleted ${id}`); }));
  
  
  return server;
}
