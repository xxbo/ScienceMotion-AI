#!/usr/bin/env bash
set -euo pipefail

render_node="$(command -v node)"
render_unit="sciencemotion-resources-$$.service"

# Run the host as the ordinary runner user in a leaf of the delegated subtree.
sudo systemd-run --wait --pipe --collect --quiet --expand-environment=no --unit="$render_unit" \
  --uid="$(id -u)" --gid="$(id -g)" --working-directory="$PWD" \
  --property='Delegate=cpu memory' --property=DelegateSubgroup=manager --property=RuntimeMaxSec=120s \
  /bin/bash -euc '
    render_node=$1
    render_unit=$2
    shift 2
    membership=$(sed -n "s/^0:://p" /proc/self/cgroup)
    if [[ "$membership" != */"$render_unit"/manager ]]; then
      printf "%s\n" "Expected the manager leaf of the delegated render service" >&2
      exit 1
    fi
    parent="/sys/fs/cgroup${membership%/manager}"
    printf "+cpu +memory\n" > "$parent/cgroup.subtree_control"
    exec "$render_node" --import tsx "$@" --cgroup-parent "$parent"
  ' bash "$render_node" "$render_unit" "$@"
