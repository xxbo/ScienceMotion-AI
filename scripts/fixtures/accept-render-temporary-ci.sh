#!/usr/bin/env bash
set -euo pipefail
source scripts/fixtures/render-volume-ci.sh

work="$(mktemp -d /tmp/sciencemotion-d3.XXXXXX)"
volume="$work/volume"
cleanup() {
  unmount_render_volume "$volume" || return 1
  rm -rf -- "$work"
}
trap cleanup EXIT

mount_render_volume "$volume" 128M
node --import tsx scripts/render-worker-temporary-acceptance.ts --temporary-volume "$volume"
