#!/bin/bash
# Build web dashboard + CLI + MCP for distribution.
# clawket-mcp lives in a sibling repo (lattice-mono/clawket-mcp) and is
# bundled into this plugin's mcp/ directory so `clawket mcp` can resolve it
# via the production path layout (<exe_dir>/../mcp/dist/index.js).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MCP_SRC="$(cd "$ROOT/../clawket-mcp" 2>/dev/null && pwd || true)"

echo "=== Building web dashboard ==="
cd "$ROOT/web" && pnpm build

echo "=== Copying web build to daemon/web ==="
rm -rf "$ROOT/daemon/web/assets"
cp -r "$ROOT/web/dist/"* "$ROOT/daemon/web/"

echo "=== Building CLI (release) ==="
cd "$ROOT/cli" && cargo build --release

echo "=== Copying CLI binary ==="
mkdir -p "$ROOT/bin"
cp "$ROOT/cli/target/release/clawket" "$ROOT/bin/clawket"
chmod +x "$ROOT/bin/clawket"

echo "=== Building clawket-mcp ==="
if [ -z "$MCP_SRC" ] || [ ! -f "$MCP_SRC/package.json" ]; then
  echo "WARN: clawket-mcp source not found at $ROOT/../clawket-mcp — skipping MCP bundle"
else
  cd "$MCP_SRC"
  pnpm install
  pnpm run build
  mkdir -p "$ROOT/mcp"
  rm -rf "$ROOT/mcp/dist" "$ROOT/mcp/node_modules" "$ROOT/mcp/pnpm-lock.yaml"
  cp -r "$MCP_SRC/dist" "$ROOT/mcp/"
  cp "$MCP_SRC/package.json" "$ROOT/mcp/"
  cd "$ROOT/mcp" && pnpm install --prod
fi

echo "=== Done ==="
