#!/usr/bin/env bash
set -euo pipefail

probe_work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/sciencemotion-d1.XXXXXX")"
probe_volume="$probe_work/volume"
probe_image="$probe_work/volume.ext4"

cleanup() {
  if mountpoint -q "$probe_volume"; then
    sudo umount -- "$probe_volume" || return 1
  fi
  rm -rf -- "$probe_work"
}
trap cleanup EXIT

mkdir -p "$probe_volume" out
truncate -s 32M "$probe_image"
mkfs.ext4 -q -F -m 0 "$probe_image"
sudo mount -t ext4 -o loop,nosuid,nodev,noexec -- "$probe_image" "$probe_volume"
sudo chown -- "$(id -u):$(id -g)" "$probe_volume"

bash scripts/fixtures/with-render-cgroup-ci.sh scripts/probe-render-resources.ts \
  --temporary-volume "$probe_volume" --require | tee out/render-resource-capability.json
