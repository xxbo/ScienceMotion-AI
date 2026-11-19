#!/usr/bin/env bash
set -euo pipefail
source scripts/fixtures/render-volume-ci.sh

probe_work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/sciencemotion-d1.XXXXXX")"
probe_volume="$probe_work/volume"
cleanup() {
  unmount_render_volume "$probe_volume" || return 1
  rm -rf -- "$probe_work"
}
trap cleanup EXIT

mkdir -p out
mount_render_volume "$probe_volume" 32M

bash scripts/fixtures/with-render-cgroup-ci.sh scripts/probe-render-resources.ts \
  --temporary-volume "$probe_volume" --require | tee out/render-resource-capability.json
