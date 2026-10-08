# sprite-mcp

An MCP server that lets Claude draw and animate pixel-art sprites. It reads and writes the same
`*.sprite.json` files as the hosted **Sprite Forge** editor, so you can go both ways:
Claude drafts a character and its animations, you polish it in the editor, export a sprite sheet
for your game.

## Install

```bash
cd sprite-mcp
npm install
mkdir -p ~/sprites
```

Point any MCP client at `src/server.js` with `SPRITES_DIR` set to your sprite folder.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sprites": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/sprite-mcp/src/server.js"],
      "env": { "SPRITES_DIR": "/Users/you/sprites" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add sprites -e SPRITES_DIR=$HOME/sprites -- node /ABSOLUTE/PATH/TO/sprite-mcp/src/server.js
```

## Tools

| tool | what it does |
|---|---|
| `list_sprites` | ids, sizes, animations in the folder |
| `create_sprite` | new sprite (`id`, `width`, `height`, optional `palette`) |
| `get_sprite` | full JSON document |
| `get_frame` | one frame as text rows **plus a PNG preview** Claude can look at |
| `set_frame` | replace a frame with text rows (`.` = transparent, `0-9a-zA-Z` = palette index) |
| `draw` | ops: `pixel`, `line`, `rect`, `ellipse`, `fill` (flood), `replace`; `mirror: true` for symmetry |
| `edit_frames` | add / duplicate / delete / move / shift / flip_x / set_duration |
| `edit_animation` | create (optionally copying frames) / rename / delete / configure fps + loop |
| `set_hitboxes` | `hurt` and `hit` boxes per frame |
| `set_palette` | set / add / remove colours |
| `export_sheet` | `<id>.png` sheet (one row per animation) + `<id>.atlas.json` (frames, frameTags, hitboxes) |
| `import_png` | slice a PNG or sheet into frames |
| `delete_sprite` | remove the file |

Try: *"Create a 32×32 sprite called `dog-red`, draw an orange space dog facing right in a fighting
stance, add a 3-frame punch animation with a hit box on the fist, then export the sheet."*

## Format

```jsonc
{
  "format": "sprite-forge/1",
  "id": "dog-red", "name": "Red Dog", "width": 32, "height": 32,
  "palette": ["#1b1b24", "#f5a623"],          // index 0 → "0", index 10 → "a", 36 → "A"
  "animations": [{
    "name": "idle", "fps": 8, "loop": true,
    "frames": [{ "rows": ["....", ".11.", ".11.", "...."], "duration": 1,
                 "hitboxes": [{ "kind": "hurt", "x": 1, "y": 1, "w": 2, "h": 2 }] }]
  }]
}
```

Open the editor's **JSON** button to paste a sprite in, or **Import PNG** to load a sheet Claude exported.
The atlas JSON follows the Aseprite layout (`frames` + `meta.frameTags`) with `hitboxes` added per frame,
so Phaser's `this.load.atlas(key, png, json)` reads it directly.

## Test

```bash
npm test
```
