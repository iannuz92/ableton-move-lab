#!/bin/sh
# Build the full Docker runtime for running Move in a Linux ARM64 container.
# Starts from the original Move image, then injects from the repository:
# - shim /emulator/libablspi_shim.so
# - GUI Node in /data/emulator-gui
# - ARM64 Node.js if missing from /data
#
# Prerequisites: Docker running, e2fsprogs/debugfs, and network access for
# downloading Node.js and the Ubuntu builder image on the first run.
# Usage: ./build.sh [/path/to/Move-Image-X.Y.Z.img]
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
IMG="${1:-$REPO_DIR/local/images/Move-Image-2.0.5.img}"
DBG="${DEBUGFS:-}"
NODE_VERSION="${NODE_VERSION:-v20.18.1}"
NODE_DIST="node-$NODE_VERSION-linux-arm64"
NODE_URL="https://nodejs.org/dist/$NODE_VERSION/$NODE_DIST.tar.xz"
SHIM_OUT="$REPO_DIR/emulator/libablspi_shim.so"
WORK="$(mktemp -d /tmp/move-build.XXXXXX)"

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

find_debugfs() {
  if [ -n "$DBG" ]; then
    printf '%s\n' "$DBG"
  elif command -v debugfs >/dev/null 2>&1; then
    command -v debugfs
  elif [ -x /opt/homebrew/opt/e2fsprogs/sbin/debugfs ]; then
    printf '%s\n' /opt/homebrew/opt/e2fsprogs/sbin/debugfs
  else
    return 1
  fi
}

fdisk_output() {
  fdisk -l "$IMG" 2>/dev/null || fdisk "$IMG" 2>/dev/null
}

# Partition offsets (512-byte sectors), read from the MBR partition table.
part_start() {
  fdisk_output | awk -v part="$1" '
    $1 ~ "^[* ]*" part ":" {
      for (i = 1; i <= NF; i += 1) {
        if ($i == "[") { print $(i + 1); exit }
        if ($i ~ /^\[/) { gsub(/^\[/, "", $i); print $i; exit }
      }
    }
    $1 ~ "p?" part "$" {
      if ($2 ~ /^[0-9]+$/) { print $2; exit }
    }
  '
}

echo "[build] image: $IMG"

test -f "$IMG"       || { echo "image not found: $IMG" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running" >&2; exit 1; }
DBG="$(find_debugfs)" || { echo "debugfs not found. Install e2fsprogs (macOS: brew install e2fsprogs; Linux: apt/dnf/pacman equivalent)" >&2; exit 1; }
test -f "$REPO_DIR/emulator/shim/ablspi_shim.c" || { echo "missing shim source" >&2; exit 1; }
test -f "$REPO_DIR/emulator/server.mjs" || { echo "missing server.mjs" >&2; exit 1; }

P2=$(( $(part_start 2) * 512 ))   # rootfs
P4=$(( $(part_start 4) * 512 ))   # /data
echo "[build] rootfs @ $P2 , data @ $P4"

echo "[build] extracting rootfs..."
mkdir -p "$WORK/rootfs"
"$DBG" -R "rdump / $WORK/rootfs" "$IMG?offset=$P2" >/dev/null 2>&1

echo "[build] compiling/injecting ARM64 shim..."
if [ ! -f "$SHIM_OUT" ] || [ "$REPO_DIR/emulator/shim/ablspi_shim.c" -nt "$SHIM_OUT" ]; then
  docker run --rm \
    --platform linux/arm64 \
    -v "$REPO_DIR/emulator:/src" \
    -w /src \
    ubuntu:22.04 \
    sh -lc '
      apt-get update >/dev/null
      apt-get install -y --no-install-recommends \
        gcc-aarch64-linux-gnu libc6-dev-arm64-cross binutils-aarch64-linux-gnu \
        >/dev/null
      aarch64-linux-gnu-gcc -O2 -Wall -Wextra -shared -fPIC \
        -o libablspi_shim.so shim/ablspi_shim.c -ldl -pthread
      aarch64-linux-gnu-readelf -h libablspi_shim.so | sed -n "1,12p"
    '
fi
test -f "$SHIM_OUT" || { echo "shim was not compiled: $SHIM_OUT" >&2; exit 1; }
mkdir -p "$WORK/rootfs/emulator"
cp "$SHIM_OUT" "$WORK/rootfs/emulator/libablspi_shim.so"
chmod 755 "$WORK/rootfs/emulator/libablspi_shim.so"

echo "[build] importing Docker image move-rootfs..."
( cd "$WORK/rootfs" && tar -cf - . ) | docker import --platform linux/arm64 - move-rootfs:latest

echo "[build] extracting /data..."
mkdir -p "$WORK/data"
"$DBG" -R "rdump / $WORK/data" "$IMG?offset=$P4" >/dev/null 2>&1

echo "[build] injecting web GUI from repository..."
rm -rf "$WORK/data/emulator-gui"
mkdir -p "$WORK/data/emulator-gui"
cp "$REPO_DIR/emulator/server.mjs" "$WORK/data/emulator-gui/server.mjs"
cp -R "$REPO_DIR/emulator/lib" "$WORK/data/emulator-gui/lib"
cp -R "$REPO_DIR/emulator/public" "$WORK/data/emulator-gui/public"

if [ ! -x "$WORK/data/$NODE_DIST/bin/node" ]; then
  echo "[build] installing ARM64 Node.js in /data ($NODE_VERSION)..."
  curl -fL "$NODE_URL" -o "$WORK/node.tar.xz"
  tar -xf "$WORK/node.tar.xz" -C "$WORK/data"
fi

echo "[build] populating move-data-vol volume..."
docker volume create move-data-vol >/dev/null
( cd "$WORK/data" && tar -cf - . ) | docker run --rm -i -v move-data-vol:/data --platform linux/arm64 move-rootfs:latest tar -C /data -xf -

echo "[build] done. Start with ./run-move.sh"
