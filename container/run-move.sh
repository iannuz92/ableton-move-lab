#!/bin/sh
# Start the emulated Move stack in a Linux ARM64 container on Mac.
# Requires ./build.sh to have been run already (move-rootfs image + move-data-vol volume).
# GUI web su http://localhost:9090
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="${NAME:-move}"

docker image inspect move-rootfs:latest >/dev/null 2>&1 || { echo "missing move-rootfs image. Run ./build.sh" >&2; exit 1; }
docker volume inspect move-data-vol   >/dev/null 2>&1 || { echo "missing move-data-vol volume. Run ./build.sh" >&2; exit 1; }

docker rm -f "$NAME" >/dev/null 2>&1 || true

echo "Starting container '$NAME'... GUI: http://localhost:9090"
exec docker run --rm -it --name "$NAME" \
  --platform linux/arm64 \
  --cap-add=SYS_NICE --cap-add=IPC_LOCK \
  --ulimit rtprio=99 --ulimit memlock=-1 \
  -p 9090:9090 \
  -e MOVE_CONTAINER_DEMO_AUDIO="${MOVE_CONTAINER_DEMO_AUDIO:-1}" \
  -e NODE_VERSION="${NODE_VERSION:-v20.18.1}" \
  -v move-data-vol:/data \
  -v "$HERE/entrypoint.sh":/entrypoint.sh:ro \
  move-rootfs:latest /bin/sh /entrypoint.sh
