#!/usr/bin/env bash

# Only the bootstrap mounts the loop device. The host, guardian and renderer
# use it with the ordinary runner user's permissions.
mount_render_volume() {
  local volume="$1" size="$2" image="${1}.ext4"
  mkdir -p "$volume"
  fallocate -l "$size" "$image"
  mkfs.ext4 -q -F -m 0 -E nodiscard "$image"
  sudo mount -t ext4 -o loop,nosuid,nodev,noexec -- "$image" "$volume"
  sudo chown -- "$(id -u):$(id -g)" "$volume"
  chmod 0700 "$volume"
}

unmount_render_volume() {
  if mountpoint -q "$1"; then
    sudo umount -- "$1"
  fi
}
