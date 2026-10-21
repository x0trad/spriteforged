// Store-agnostic tool registration — used by the stdio server (local files) and the HTTP server (Vercel Blob).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import * as F from "./format.js";
import { pixellabClient, syncCharacter } from "./pixellab.js";

export function buildServer(store, opts = {}) {
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
  

  // ---------- PixelLab (AI generation) ----------
  const pl = opts.pixellab || pixellabClient();
  const Wait = z.number().int().min(0).max(290).default(45).describe("Seconds to wait for PixelLab before returning. Jobs usually take 1-5 min; if it isn't done, call pixellab_sync later. Keep under 50 on the cloud server.");
  async function finish(s, budget, startedNote) {
    const meta = s.pixellab;
    let w = { done: true, failed: [], pending: [] };
    if (meta.jobs?.length) w = await pl.waitJobs(meta.jobs, budget * 1000);
    if (w.failed.length) meta.jobs = meta.jobs.filter((j) => !w.failed.some((f) => f.id === j));
    if (w.pending.length) {
      meta.jobs = w.pending;
      await save(s);
      return text({ status: "processing", note: `${startedNote} Still generating on PixelLab — call pixellab_sync with id "${s.id}" in a minute or two.`, pending_jobs: w.pending.length, failed: w.failed });
    }
    meta.jobs = [];
    const r = await syncCharacter(pl, s);
    await save(s);
    const newest = r.added.length ? s.animations[s.animations.length - 1] : s.animations[0];
    const shot = F.renderFramePNG(s, newest.frames[0], Math.max(1, Math.floor(256 / Math.max(s.width, s.height))));
    return image(shot, JSON.stringify({ status: "done", imported: r.added, failed: w.failed, ...summary(s) }, null, 1));
  }

  server.registerTool("pixellab_balance", {
    description: "Show the PixelLab account's remaining credits / generations (needs PIXELLAB_TOKEN on the server).",
    inputSchema: {},
  }, wrap(async () => text(await pl.call("GET", "/balance"))));

  server.registerTool("pixellab_create_character", {
    description: "Generate a pixel-art character with PixelLab (create-character-v3: 4 or 8 directional views) and save it as a new Sprite Forge sprite. The views land in the 'rotations' animation and the facing view becomes 'idle'. Costs PixelLab generations. Follow with pixellab_animate for walk/attack/etc.",
    inputSchema: {
      id: z.string().describe("New sprite id, e.g. 'gohantar-rider'"),
      description: z.string().describe("What the character looks like, e.g. 'delivery rider on a red kapchai motorbike, orange helmet, teal jacket'"),
      size: z.number().int().min(32).max(128).default(64).describe("Character size in px (square)"),
      directions: z.union([z.literal(4), z.literal(8)]).default(8),
      view: z.enum(["side", "low top-down", "high top-down"]).default("side"),
      facing: z.enum(["east", "west", "south", "north"]).default("east").describe("Which view becomes the idle frame"),
      outline: z.string().optional().describe("e.g. 'single color black outline', 'selective outline', 'lineless'"),
      detail: z.string().optional().describe("e.g. 'low detail', 'medium detail', 'highly detailed'"),
      seed: z.number().int().optional(),
      wait_seconds: Wait,
    },
  }, wrap(async ({ id, description, size, directions, view, facing, outline, detail, seed, wait_seconds }) => {
    if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) throw new Error(`Bad sprite id "${id}" (use letters, digits, - and _)`);
    if (await store.read(id)) throw new Error(`Sprite "${id}" already exists — pick a new id`);
    const body = { description, n_directions: directions, view, image_size: { width: size, height: size }, name: id };
    if (outline) body.outline = outline;
    if (detail) body.detail = detail;
    if (seed !== undefined) body.seed = seed;
    const r = await pl.call("POST", "/create-character-v3", body);
    const s = F.newSprite({ id, name: id, width: size, height: size, palette: [] });
    s.palette = [];
    s.pixellab = { character_id: r.character_id, jobs: [r.background_job_id], facing, sized: false, prompt: description, imported: [], names: {} };
    await save(s);
    return finish(s, wait_seconds, `Started PixelLab character ${r.character_id}.`);
  }));

  server.registerTool("pixellab_animate", {
    description: "Add an AI animation to a sprite made with pixellab_create_character. mode 'v3' (default) animates from a text action, e.g. 'walking cycle', 'riding motorbike, wheels spinning', 'jab punch'. mode 'template' uses a PixelLab template id (e.g. 'breathing-idle', 'cross-punch', 'backflip'). Frames land in an animation named after `name` (plus '-<direction>' when several directions). Costs PixelLab generations per direction.",
    inputSchema: {
      id: z.string(),
      action: z.string().optional().describe("v3/pixminimax: what happens, e.g. 'walking cycle'"),
      name: z.string().optional().describe("Animation name in Sprite Forge (default: from the action)"),
      mode: z.enum(["v3", "template", "pixminimax"]).default("v3"),
      template: z.string().optional().describe("template mode: PixelLab template_animation_id"),
      frame_count: z.number().int().min(4).max(40).default(8).describe("v3: 4-16 even; pixminimax: multiple of 4 up to 40"),
      directions: z.array(z.string()).optional().describe("e.g. ['east'] (default: the sprite's facing). Each direction costs extra."),
      wait_seconds: Wait,
    },
  }, wrap(async ({ id, action, name, mode, template, frame_count, directions, wait_seconds }) => {
    const s = await load(id);
    if (!s.pixellab?.character_id) throw new Error(`Sprite "${id}" isn't a PixelLab character — create it with pixellab_create_character.`);
    if (s.pixellab.jobs?.length) throw new Error(`"${id}" still has PixelLab jobs running — call pixellab_sync first.`);
    if (mode === "template" && !template) throw new Error("template mode needs `template`");
    if (mode !== "template" && !action) throw new Error("Give `action`, e.g. 'walking cycle'");
    const body = { character_id: s.pixellab.character_id, mode, directions: directions?.length ? directions : [s.pixellab.facing || "east"] };
    if (mode === "template") body.template_animation_id = template;
    else { body.action_description = action; body.frame_count = frame_count; }
    body.animation_name = name || action || template;
    const r = await pl.call("POST", "/characters/animations", body);
    const jobs = r.background_job_ids || (r.background_job_id ? [r.background_job_id] : []);
    s.pixellab.jobs = jobs;
    if (r.animation_group_id) s.pixellab.names[r.animation_group_id] = name || action || template;
    await save(s);
    return finish(s, wait_seconds, `Started ${jobs.length} PixelLab animation job(s).`);
  }));

  server.registerTool("pixellab_sync", {
    description: "Finish a PixelLab generation: wait for any running jobs on the sprite, then import new rotations/animations from its PixelLab character. Safe to call repeatedly.",
    inputSchema: { id: z.string(), wait_seconds: Wait },
  }, wrap(async ({ id, wait_seconds }) => {
    const s = await load(id);
    if (!s.pixellab?.character_id) throw new Error(`Sprite "${id}" isn't linked to a PixelLab character.`);
    return finish(s, wait_seconds, "");
  }));

  server.registerTool("delete_sprite", {
    description: "Delete a sprite file permanently.",
    inputSchema: { id: z.string() },
  }, wrap(async ({ id }) => { await load(id); await store.remove(id); return text(`Deleted ${id}`); }));
  
  
  return server;
}
