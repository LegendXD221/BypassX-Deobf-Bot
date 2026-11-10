#!/usr/bin/env bash
# Build the jte Lua bytecode decompiler CLI (research/jte-lua-decompiler) into
# the repo's bin/ so the pipeline's bytecode-lift adapter (src/jte-lift.js)
# picks it up automatically. Requires the Rust toolchain (cargo).
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="research/jte-lua-decompiler/lua-decompiler-ast"
if [ ! -d "$SRC" ]; then
  echo "jte vendored tree missing: $SRC" >&2
  exit 1
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not found — install the Rust toolchain first (https://rustup.rs)" >&2
  exit 1
fi

mkdir -p bin
(cd "$SRC" && cargo build --release -p cli)
cp "$SRC/target/release/cli" bin/jte
echo "built: bin/jte — the pipeline now decompiles captured bytecode automatically"
