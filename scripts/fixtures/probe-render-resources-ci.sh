#!/usr/bin/env bash
set -euo pipefail

probe_node="$(command -v node)"
probe_work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/sciencemotion-d1.XXXXXX")"
probe_volume="$probe_work/volume"
probe_image="$probe_work/volume.ext4"
probe_unit="sciencemotion-d1-$$.service"

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

# The probe runs as the ordinary runner user. The service keeps it in a leaf
# so the delegated parent can enable the domain controllers for job children.
sudo systemd-run --wait --pipe --collect --quiet --unit="$probe_unit" \
  --uid="$(id -u)" --gid="$(id -g)" --working-directory="$PWD" \
  --property='Delegate=cpu memory' --property=DelegateSubgroup=manager --property=RuntimeMaxSec=45s \
  /bin/bash -euc '
    probe_membership=$(sed -n "s/^0:://p" /proc/self/cgroup)
    if [[ "$probe_membership" != */"$3"/manager ]]; then
      printf "%s\n" "Expected the manager leaf of the dedicated probe service" >&2
      exit 1
    fi
    probe_parent="/sys/fs/cgroup${probe_membership%/manager}"
    printf "+cpu +memory\n" > "$probe_parent/cgroup.subtree_control"
    exec "$1" --import tsx scripts/probe-render-resources.ts \
      --cgroup-parent "$probe_parent" --temporary-volume "$2" --require
  ' bash "$probe_node" "$probe_volume" "$probe_unit" | tee out/render-resource-capability.json
