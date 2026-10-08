// Storage backends. Both expose: list() → ids, read(id) → doc|null, write(id, doc), remove(id), putFile(name, buf, type) → location.
import fs from "node:fs/promises";
import path from "node:path";

export function fsStore(dir) {
  const fileFor = (id) => path.join(dir, `${id}.sprite.json`);
  return {
    kind: "fs", location: dir,
    async list() {
      await fs.mkdir(dir, { recursive: true });
      return (await fs.readdir(dir)).filter((f) => f.endsWith(".sprite.json")).map((f) => f.replace(/\.sprite\.json$/, ""));
    },
    async read(id) { try { return JSON.parse(await fs.readFile(fileFor(id), "utf8")); } catch { return null; } },
    async write(id, doc) { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(fileFor(id), JSON.stringify(doc, null, 1)); },
    async remove(id) { await fs.unlink(fileFor(id)); },
    async putFile(name, buf, _type, outDir) { const d = path.resolve(outDir || dir); await fs.mkdir(d, { recursive: true }); const p = path.join(d, name); await fs.writeFile(p, buf); return p; },
  };
}

// Vercel Blob backend. Needs BLOB_READ_WRITE_TOKEN (auto-injected when a Blob store is connected to the project).
export function blobStore() {
  const access = process.env.BLOB_ACCESS || "public";
  const recent = new Map(); // id → last doc written by this instance (beats CDN staleness on warm instances)
  let blob;
  const mod = async () => (blob ||= await import("@vercel/blob"));
  const pathFor = (id) => `sprites/${id}.sprite.json`;
  return {
    kind: "blob", location: "Vercel Blob",
    async list() {
      const { list } = await mod();
      const ids = [];
      let cursor;
      do {
        const r = await list({ prefix: "sprites/", cursor, limit: 500 });
        for (const b of r.blobs) if (b.pathname.endsWith(".sprite.json")) ids.push(b.pathname.slice("sprites/".length, -".sprite.json".length));
        cursor = r.cursor;
      } while (cursor);
      return ids;
    },
    async read(id) {
      const { get } = await mod();
      let doc = null;
      try {
        const r = await get(pathFor(id), { access });
        if (r && r.statusCode === 200) doc = JSON.parse(await new Response(r.stream).text());
      } catch (e) { if (!/not.?found/i.test(String(e))) throw e; }
      const cached = recent.get(id);
      if (cached && (!doc || (cached.updatedAt || 0) > (doc.updatedAt || 0))) return cached;
      return doc;
    },
    async write(id, doc) {
      const { put } = await mod();
      recent.set(id, doc);
      await put(pathFor(id), JSON.stringify(doc), { access, contentType: "application/json", addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 });
    },
    async remove(id) { const { del } = await mod(); recent.delete(id); await del(pathFor(id)); },
    async putFile(name, buf, type) {
      const { put } = await mod();
      const r = await put(`exports/${name}`, buf, { access, contentType: type, addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60 });
      return r.downloadUrl || r.url;
    },
  };
}

// Ephemeral fallback for a cloud deploy without a Blob store: works for a single conversation, then forgets.
export function tmpStore() {
  const s = fsStore("/tmp/sprites");
  s.kind = "tmp";
  s.location = "/tmp (EPHEMERAL — connect a Vercel Blob store to keep sprites)";
  return s;
}
