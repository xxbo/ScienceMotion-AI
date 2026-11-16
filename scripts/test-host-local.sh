#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
# This isolates host policy/service tests; npm test also runs the real filesystem/Ajv assembly tests.
./node_modules/.bin/tsc --strict --skipLibCheck --target ES2022 --module commonjs --esModuleInterop \
  --resolveJsonModule --typeRoots ./node_modules/@types --outDir "$OUT" \
  src/platform/creative-host.test.ts src/platform/creative-editing.test.ts
node --test "$OUT/src/platform/creative-host.test.js" "$OUT/src/platform/creative-editing.test.js"
