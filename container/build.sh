#!/bin/sh
# Costruisce l'ambiente Docker completo per eseguire Move sul Mac (Linux ARM64).
# Parte dall'immagine originale Move, poi inietta dal repo:
# - shim /emulator/libablspi_shim.so
# - GUI Node in /data/emulator-gui
# - Node.js ARM64 se manca in /data
#
# Prerequisiti: Docker in esecuzione, e2fsprogs (brew install e2fsprogs), rete
# per scaricare Node.js e l'immagine builder Ubuntu al primo run.
# Uso: ./build.sh [/percorso/Move-Image-X.Y.Z.img]
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
IMG="${1:-$REPO_DIR/local/images/Move-Image-2.0.5.img}"
DBG="${DEBUGFS:-/opt/homebrew/opt/e2fsprogs/sbin/debugfs}"
NODE_VERSION="${NODE_VERSION:-v20.18.1}"
NODE_DIST="node-$NODE_VERSION-linux-arm64"
NODE_URL="https://nodejs.org/dist/$NODE_VERSION/$NODE_DIST.tar.xz"
SHIM_OUT="$REPO_DIR/emulator/libablspi_shim.so"
WORK="$(mktemp -d /tmp/move-build.XXXXXX)"

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# Offset delle partizioni (settori da 512 byte), letti dalla tabella MBR.
part_start() { /usr/sbin/fdisk "$IMG" 2>/dev/null | grep -E "^[* ]*$1:" | sed -E 's/.*\[([^]]*)\].*/\1/' | awk '{print $1}'; }

echo "[build] immagine: $IMG"

test -f "$IMG"       || { echo "immagine non trovata: $IMG" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker non è in esecuzione" >&2; exit 1; }
test -x "$DBG"       || { echo "debugfs non trovato ($DBG). brew install e2fsprogs" >&2; exit 1; }
test -f "$REPO_DIR/emulator/shim/ablspi_shim.c" || { echo "shim source mancante" >&2; exit 1; }
test -f "$REPO_DIR/emulator/server.mjs" || { echo "server.mjs mancante" >&2; exit 1; }

P2=$(( $(part_start 2) * 512 ))   # rootfs
P4=$(( $(part_start 4) * 512 ))   # /data
echo "[build] rootfs @ $P2 , data @ $P4"

echo "[build] estraggo la rootfs..."
mkdir -p "$WORK/rootfs"
"$DBG" -R "rdump / $WORK/rootfs" "$IMG?offset=$P2" >/dev/null 2>&1

echo "[build] compilo/inietto lo shim ARM64..."
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
test -f "$SHIM_OUT" || { echo "shim non compilato: $SHIM_OUT" >&2; exit 1; }
mkdir -p "$WORK/rootfs/emulator"
cp "$SHIM_OUT" "$WORK/rootfs/emulator/libablspi_shim.so"
chmod 755 "$WORK/rootfs/emulator/libablspi_shim.so"

echo "[build] importo l'immagine Docker move-rootfs..."
( cd "$WORK/rootfs" && tar -cf - . ) | docker import --platform linux/arm64 - move-rootfs:latest

echo "[build] estraggo /data..."
mkdir -p "$WORK/data"
"$DBG" -R "rdump / $WORK/data" "$IMG?offset=$P4" >/dev/null 2>&1

echo "[build] inietto GUI web dal repo..."
rm -rf "$WORK/data/emulator-gui"
mkdir -p "$WORK/data/emulator-gui"
cp "$REPO_DIR/emulator/server.mjs" "$WORK/data/emulator-gui/server.mjs"
cp -R "$REPO_DIR/emulator/lib" "$WORK/data/emulator-gui/lib"
cp -R "$REPO_DIR/emulator/public" "$WORK/data/emulator-gui/public"

if [ ! -x "$WORK/data/$NODE_DIST/bin/node" ]; then
  echo "[build] installo Node.js ARM64 in /data ($NODE_VERSION)..."
  curl -fL "$NODE_URL" -o "$WORK/node.tar.xz"
  tar -xf "$WORK/node.tar.xz" -C "$WORK/data"
fi

echo "[build] popolo il volume move-data-vol..."
docker volume create move-data-vol >/dev/null
( cd "$WORK/data" && tar -cf - . ) | docker run --rm -i -v move-data-vol:/data --platform linux/arm64 move-rootfs:latest tar -C /data -xf -

echo "[build] fatto. Avvia con ./run-move.sh"
