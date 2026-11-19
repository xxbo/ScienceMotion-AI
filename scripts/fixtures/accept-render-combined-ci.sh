#!/usr/bin/env bash
set -euo pipefail
source scripts/fixtures/render-volume-ci.sh

work="$(mktemp -d /tmp/sciencemotion-d4.XXXXXX)"
first="$work/first"
second="$work/second"
cleanup() {
  local status=0
  unmount_render_volume "$second" || status=1
  unmount_render_volume "$first" || status=1
  if (( status == 0 )); then
    rm -rf -- "$work"
  fi
  return "$status"
}
trap cleanup EXIT

mount_render_volume "$first" 128M
mount_render_volume "$second" 128M
bash scripts/fixtures/with-render-cgroup-ci.sh scripts/render-worker-combined-acceptance.ts \
  --temporary-volume "$first" --temporary-volume "$second"
