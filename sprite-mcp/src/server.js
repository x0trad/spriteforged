#!/usr/bin/env node
// sprite-mcp (local, stdio) — for Claude Desktop, Claude Code, Cursor, etc.
// Sprites live as <SPRITES_DIR>/<id>.sprite.json (default ./sprites).
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./tools.js";
import { fsStore } from "./store.js";

const DIR = path.resolve(process.env.SPRITES_DIR || process.argv[2] || "./sprites");
const server = buildServer(fsStore(DIR));
await server.connect(new StdioServerTransport());
