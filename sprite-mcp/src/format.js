// Sprite Forge document format — shared with the hosted editor.
//
// {
//   format: "sprite-forge/1", id, name, width, height,
//   palette: ["#rrggbb", ...],              // index i is written as ALPHA[i]
//   animations: [{ name, fps, loop, frames: [{ rows, duration, hitboxes }] }],
//   updatedAt, rev
// }
// A frame's `rows` is `height` strings of `width` characters: "." is transparent,
// any other character is ALPHA.indexOf(ch) → palette index.

import { PNG } from "pngjs";

export const ALPHA = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const T = ".";
export const cIdx = (c) => (c === T ? -1 : ALPHA.indexOf(c));
export const iChr = (i) => (i < 0 ? T : ALPHA[i]);

export function blankRows(w, h) {
  return Array.from({ length: h }, () => T.repeat(w));
}

export function newSprite({ id, name, width, height, palette }) {
  const s = {
    format: "sprite-forge/1",
    id,
    name: name || id,
    width,
    height,
    palette: palette && palette.length ? palette : ["#1b1b24", "#f5a623", "#ffd27a", "#ffffff", "#3b2a12", "#f0564f", "#38c8cc"],
    animations: [{ name: "idle", fps: 8, loop: true, frames: [{ rows: blankRows(width, height), duration: 1, hitboxes: [] }] }],
    updatedAt: Date.now(),
    rev: "mcp-0",
  };
  return s;
}

export function normalize(s) {
  if (!s || !Array.isArray(s.animations)) throw new Error("Not a Sprite Forge sprite (missing animations)");
  s.format = "sprite-forge/1";
  s.width = Number(s.width);
  s.height = Number(s.height);
  s.palette = (s.palette || []).slice(0, ALPHA.length);
  for (const a of s.animations) {
    a.fps = a.fps || 8;
    a.loop = a.loop !== false;
    a.frames = a.frames || [];
    for (const f of a.frames) {
      f.rows = Array.from({ length: s.height }, (_, y) => ((f.rows || [])[y] || "").padEnd(s.width, T).slice(0, s.width));
      f.duration = f.duration || 1;
      f.hitboxes = f.hitboxes || [];
    }
  }
  return s;
}

export function touch(s) {
  s.updatedAt = Date.now();
  s.rev = "mcp-" + Math.random().toString(36).slice(2, 8);
}

export function findAnim(s, name) {
  const a = s.animations.find((x) => x.name === name);
  if (!a) throw new Error(`No animation "${name}". Available: ${s.animations.map((x) => x.name).join(", ")}`);
  return a;
}
export function getFrame(s, animName, index) {
  const a = findAnim(s, animName);
  if (index < 0 || index >= a.frames.length) throw new Error(`Frame ${index} out of range (animation "${animName}" has ${a.frames.length} frames)`);
  return a.frames[index];
}

// ---- colour helpers ----
export function hexToRgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
export function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}
export function nearest(pal, hex) {
  const [r, g, b] = hexToRgb(hex);
  let bi = 0, bd = Infinity;
  pal.forEach((p, i) => { const [pr, pg, pb] = hexToRgb(p); const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2; if (d < bd) { bd = d; bi = i; } });
  return bi;
}
/** Resolve a colour argument to a palette character. Accepts ".", a palette char, or "#rrggbb" (added to the palette if new). */
export function colorChar(s, color) {
  if (color === undefined || color === null || color === "" || color === T || color === "transparent") return T;
  if (typeof color === "number") {
    if (color < 0 || color >= s.palette.length) throw new Error(`Palette index ${color} out of range (0-${s.palette.length - 1})`);
    return iChr(color);
  }
  color = String(color);
  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    const hex = color.toLowerCase();
    let i = s.palette.indexOf(hex);
    if (i < 0) {
      if (s.palette.length >= ALPHA.length) throw new Error("Palette is full (62 colours)");
      s.palette.push(hex);
      i = s.palette.length - 1;
    }
    return iChr(i);
  }
  if (color.length === 1 && cIdx(color) >= 0 && cIdx(color) < s.palette.length) return color;
  throw new Error(`Unknown colour "${color}". Use "#rrggbb", a palette character (${s.palette.map((_, i) => iChr(i)).join("")}), or "." for transparent.`);
}

// ---- drawing on a mutable grid (array of char arrays) ----
export const grid = (f) => f.rows.map((r) => r.split(""));
export const ungrid = (f, g) => { f.rows = g.map((r) => r.join("")); };

export function setPx(g, x, y, c, s, mirror) {
  if (x < 0 || y < 0 || x >= s.width || y >= s.height) return;
  g[y][x] = c;
  if (mirror) g[y][s.width - 1 - x] = c;
}
export function line(g, x0, y0, x1, y1, c, s, m) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let e = dx + dy;
  for (;;) {
    setPx(g, x0, y0, c, s, m);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * e;
    if (e2 >= dy) { e += dy; x0 += sx; }
    if (e2 <= dx) { e += dx; y0 += sy; }
  }
}
export function rect(g, x, y, w, h, c, s, fill, m) {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++)
      if (fill || yy === y || yy === y + h - 1 || xx === x || xx === x + w - 1) setPx(g, xx, yy, c, s, m);
}
export function ellipse(g, cx, cy, rx, ry, c, s, fill, m) {
  for (let yy = Math.floor(cy - ry); yy <= Math.ceil(cy + ry); yy++)
    for (let xx = Math.floor(cx - rx); xx <= Math.ceil(cx + rx); xx++) {
      const d = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2;
      const inner = ((xx - cx) / Math.max(rx - 1, 0.5)) ** 2 + ((yy - cy) / Math.max(ry - 1, 0.5)) ** 2;
      if (d <= 1 && (fill || inner > 1)) setPx(g, xx, yy, c, s, m);
    }
}
export function fill(g, x, y, c, s) {
  const t = g[y]?.[x];
  if (t === undefined || t === c) return;
  const st = [[x, y]];
  while (st.length) {
    const [px, py] = st.pop();
    if (px < 0 || py < 0 || px >= s.width || py >= s.height || g[py][px] !== t) continue;
    g[py][px] = c;
    st.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
  }
}
export function replaceColor(g, from, to, s) {
  for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) if (g[y][x] === from) g[y][x] = to;
}
export function shift(f, dx, dy, s) {
  const out = blankRows(s.width, s.height).map((r) => r.split(""));
  const g = grid(f);
  for (let y = 0; y < s.height; y++)
    for (let x = 0; x < s.width; x++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < s.width && ny < s.height) out[ny][nx] = g[y][x];
    }
  ungrid(f, out);
  for (const b of f.hitboxes) { b.x += dx; b.y += dy; }
}
export function flipX(f, s) {
  f.rows = f.rows.map((r) => r.split("").reverse().join(""));
  for (const b of f.hitboxes) b.x = s.width - b.x - b.w;
}

// ---- PNG rendering ----
export function renderFramePNG(s, f, scale = 1) {
  const png = new PNG({ width: s.width * scale, height: s.height * scale });
  paintInto(png, s, f, 0, 0, scale);
  return PNG.sync.write(png);
}
function paintInto(png, s, f, ox, oy, scale) {
  for (let y = 0; y < s.height; y++) {
    const row = f.rows[y] || "";
    for (let x = 0; x < s.width; x++) {
      const i = cIdx(row[x] || T);
      if (i < 0 || !s.palette[i]) continue;
      const [r, g, b] = hexToRgb(s.palette[i]);
      for (let sy = 0; sy < scale; sy++)
        for (let sx = 0; sx < scale; sx++) {
          const o = (((oy + y * scale + sy) * png.width) + (ox + x * scale + sx)) * 4;
          png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
        }
    }
  }
}
/** Sprite sheet: one row per animation, frames left→right. Returns {png: Buffer, meta}. */
export function renderSheet(s) {
  const maxF = Math.max(...s.animations.map((a) => a.frames.length));
  const png = new PNG({ width: maxF * s.width, height: s.animations.length * s.height });
  const meta = { frames: {}, meta: { app: "Sprite Forge", format: "sprite-forge/1", image: s.id + ".png", size: { w: png.width, h: png.height }, frameSize: { w: s.width, h: s.height }, frameTags: [], palette: s.palette } };
  s.animations.forEach((a, ai) => {
    a.frames.forEach((f, fi) => {
      paintInto(png, s, f, fi * s.width, ai * s.height, 1);
      meta.frames[`${a.name}_${fi}`] = { frame: { x: fi * s.width, y: ai * s.height, w: s.width, h: s.height }, duration: Math.round((1000 / a.fps) * (f.duration || 1)), hitboxes: f.hitboxes || [] };
    });
    meta.meta.frameTags.push({ name: a.name, from: 0, to: a.frames.length - 1, fps: a.fps, loop: a.loop, row: ai, direction: "forward" });
  });
  return { png: PNG.sync.write(png), meta };
}
/** Import a PNG buffer into frames of size w×h (sliced left→right, top→bottom). Adds colours to the palette. */
export function importPNG(s, buf, fw, fh) {
  const png = PNG.sync.read(buf);
  const cols = Math.max(1, Math.floor(png.width / fw)), rowsN = Math.max(1, Math.floor(png.height / fh));
  const frames = [];
  for (let ry = 0; ry < rowsN; ry++)
    for (let cx = 0; cx < cols; cx++) {
      const rows = [];
      let empty = true;
      for (let y = 0; y < fh; y++) {
        let r = "";
        for (let x = 0; x < fw; x++) {
          const o = ((ry * fh + y) * png.width + (cx * fw + x)) * 4;
          if (png.data[o + 3] < 128) { r += T; continue; }
          empty = false;
          const hex = rgbToHex(png.data[o], png.data[o + 1], png.data[o + 2]);
          r += s.palette.length >= ALPHA.length && !s.palette.includes(hex) ? iChr(nearest(s.palette, hex)) : colorChar(s, hex);
        }
        rows.push(r);
      }
      if (!empty || cols * rowsN === 1) frames.push({ rows, duration: 1, hitboxes: [] });
    }
  return frames;
}
