# Ableton Move Lab

This repository contains the open tooling needed to run the Ableton Move
software stack with a browser-based control surface.

It supports two targets:

- **Linux ARM64 container with Docker**: fastest way to run the Move stack
  locally and open the GUI at `http://localhost:9090`. This is tested on Apple
  Silicon, but it is not Mac-only.
- **Raspberry Pi 4 image**: creates a bootable microSD image from the original
  Move recovery image, then runs Move natively with the GUI exposed over the
  Move/Raspberry USB network interface at `http://172.16.254.1:9090`.

## Legal And Repository Boundary

This repository intentionally contains only open project files:

- scripts;
- LD_PRELOAD shim source code;
- Node.js server;
- browser UI;
- tests;
- engineering notes.

It does **not** contain:

- Ableton Move `.img` files;
- proprietary Ableton binaries;
- proprietary manuals or PDFs;
- extracted root filesystems;
- runtime logs or captures.

Anyone cloning the repository must download the original Move recovery image
locally.

Official Ableton recovery download:

```text
https://www.ableton.com/download/hardware/latest/move/recovery/
```

Place the downloaded image here:

```text
local/images/Move-Image-2.0.5.img
```

`local/` is ignored by Git, so the downloaded image stays outside the public
repository.

## Requirements

Common requirements:

- Docker Engine or Docker Desktop with `linux/arm64` support for the container
  path;
- internet access on first build;
- original Ableton Move recovery image at `local/images/Move-Image-2.0.5.img`;
- `e2fsprogs` and `fdisk`/`util-linux` tools.

macOS:

```sh
brew install e2fsprogs
```

Debian/Ubuntu Linux:

```sh
sudo apt-get install e2fsprogs fdisk
```

`e2fsprogs` provides tools such as `debugfs` and `e2fsck`. The scripts use them
to read, edit, and check ext partitions inside the Move image without mounting
the image directly.

Apple Silicon and ARM64 Linux hosts can run the container natively. x86_64 Linux
hosts need Docker/QEMU binfmt support for `linux/arm64`, and performance may be
slower.

Extra Raspberry requirements:

- Raspberry Pi 4;
- microSD card;
- a local SSH public key, usually `~/.ssh/id_rsa.pub`;
- a microSD writer, such as Raspberry Pi Imager or `dd`;
- USB network access to the Pi at `172.16.254.1`.

`172.16.254.1` is the default Move/Raspberry USB gadget address. It is not a
Wi-Fi or Ethernet address.

## How It Works

The original Move image contains the Linux ARM64 root filesystem, `/data`
partition, and Ableton binaries. This repository adds the missing pieces needed
to drive those binaries outside the original hardware shell:

- `emulator/shim/ablspi_shim.c` emulates the XMOS/SPI boundary through
  `LD_PRELOAD`.
- `emulator/server.mjs` exposes a local HTTP API and serves the browser GUI.
- `emulator/public/` renders the Move display, pads, buttons, LEDs, and audio.
- `emulator/lib/` parses display, LED, MIDI, and audio data.
- `container/` builds and starts a Linux ARM64 Docker runtime from the original
  Move image.
- `raspberry/` prepares and runs a native Raspberry Pi 4 image.

The shim writes runtime data under:

```text
/emulator/spi/
/emulator/input/
```

The web GUI reads display/LED/audio output from the shim and writes control
events back to the Move engine.

## Repository Layout

```text
emulator/
  server.mjs              # API + static web GUI server
  public/                 # browser frontend
  lib/                    # display, LED, MIDI, and audio protocol helpers
  shim/                   # LD_PRELOAD C shim source
  tools/                  # manual reverse/debug tools
  tests/                  # Node tests
  docs/                   # emulator engineering notes

container/
  build.sh                # builds the full container runtime from the original image
  run-move.sh             # starts the container
  entrypoint.sh           # starts services + Move inside the container
  README.md               # detailed container guide

raspberry/
  make-image.sh           # prepares a Raspberry Pi image from the local Move image
  start-native.sh         # native runtime launcher for the Pi
  README.md               # detailed Raspberry guide
```

## Container Guide

Use this path to run Move locally with Docker.

### 1. Put The Original Image In Place

Download the Move recovery image from Ableton and place it here:

```text
local/images/Move-Image-2.0.5.img
```

### 2. Build The Runtime

```sh
cd container
./build.sh
```

If the image is stored somewhere else:

```sh
./build.sh /path/to/Move-Image-2.0.5.img
```

`build.sh` does the full local build:

- reads the MBR partition table from the original Move image;
- extracts the root filesystem partition;
- extracts the `/data` partition;
- compiles `emulator/shim/ablspi_shim.c` into
  `emulator/libablspi_shim.so` if needed;
- imports the root filesystem as Docker image `move-rootfs:latest`;
- creates and populates Docker volume `move-data-vol`;
- copies the web GUI into `/data/emulator-gui`;
- installs ARM64 Node.js into `/data` if missing.

Ableton binaries are extracted locally from the original image and are never
committed to Git.

### 3. Run The Container

```sh
./run-move.sh
```

Then open:

```text
http://localhost:9090
```

`run-move.sh` starts a container named `move` with:

- port `9090` exposed on `localhost`;
- `move-data-vol` mounted at `/data`;
- `entrypoint.sh` mounted read-only;
- scheduling/audio capabilities:
  - `SYS_NICE`
  - `IPC_LOCK`
  - `rtprio=99`
  - `memlock=-1`

To disable the automatic demo set/volume seed:

```sh
MOVE_CONTAINER_DEMO_AUDIO=0 ./run-move.sh
```

### 4. What Starts Inside The Container

`entrypoint.sh` starts the full service stack expected by the Move binaries:

1. D-Bus system bus.
2. ConnMan.
3. Avahi.
4. SWUpdate IPC:
   - `/tmp/swupdateprog`
   - `/tmp/sockinstctrl`
5. Placeholder SPI device:
   - `/dev/ablspi0.0`
6. Shim working directories:
   - `/emulator/input`
   - `/emulator/spi`
7. Node GUI:
   - `/data/emulator-gui/server.mjs`
8. `MoveLauncher` with `LD_PRELOAD=/emulator/libablspi_shim.so`.
9. XMOS firmware handshake wait.
10. `Move.nocap` engine with audio/display streaming enabled.
11. Initial Shift tap to wake the display/engine.

SWUpdate IPC is required. Without `/tmp/swupdateprog` and `/tmp/sockinstctrl`,
the Move process can stay alive and the GUI can return HTTP 200, but the active
SPI/audio loop may not start and `/emulator/spi/audio.raw` may not grow.

### 5. Verify The Container

Container:

```sh
docker ps --filter name=move
```

GUI API:

```sh
curl http://localhost:9090/api/status
```

Expected:

```json
{"bridge":"running"}
```

Display:

```sh
curl http://localhost:9090/api/display
```

Expected:

```json
{"available":true,"width":128,"height":64}
```

Audio growth:

```sh
docker cp move:/emulator/spi/audio.raw /tmp/audio-1.raw
sleep 3
docker cp move:/emulator/spi/audio.raw /tmp/audio-2.raw
ls -l /tmp/audio-1.raw /tmp/audio-2.raw
```

The file should grow. Approximate target for 44.1 kHz stereo 16-bit PCM:

```text
~176400 B/s
```

Trigger playback and inspect non-zero PCM:

```sh
curl -X POST http://localhost:9090/api/control \
  -H 'content-type: application/json' \
  -d '{"type":"button","id":"play","action":"press"}'

curl -X POST http://localhost:9090/api/control \
  -H 'content-type: application/json' \
  -d '{"type":"button","id":"play","action":"release"}'

docker cp move:/emulator/spi/audio.raw /tmp/move-audio.raw
python3 - <<'PY'
from pathlib import Path
p = Path('/tmp/move-audio.raw')
data = p.read_bytes()[-176400:]
print('sample_bytes', len(data))
print('nonzero', sum(1 for b in data if b))
print('unique', len(set(data)) if data else 0)
PY
```

### 6. Container Logs And Reset

Enter the container:

```sh
docker exec -it move sh
```

Useful logs:

```text
/tmp/move-launcher.log
/tmp/move.log
/tmp/gui.log
/tmp/swupdate.log
```

Shim output:

```text
/emulator/spi/tx-packets.bin
/emulator/spi/audio.raw
/emulator/spi/script.log
/emulator/input/midi.bin
```

Restart only the container:

```sh
./run-move.sh
```

Rebuild from scratch:

```sh
docker rm -f move 2>/dev/null || true
docker volume rm move-data-vol 2>/dev/null || true
docker image rm move-rootfs:latest 2>/dev/null || true
./build.sh
./run-move.sh
```

## Raspberry Pi 4 Guide

Use this path to create a bootable Raspberry Pi 4 microSD image and run Move
natively with the same web GUI.

### 1. Put The Original Image In Place

Download the Move recovery image from Ableton and place it here:

```text
local/images/Move-Image-2.0.5.img
```

### 2. Build The Shim

If this file already exists:

```text
emulator/libablspi_shim.so
```

you can skip this step.

Otherwise:

```sh
./emulator/build-shim.sh
```

On a host without a Linux ARM64 toolchain, the simplest path is to run the
container build first because it compiles the shim with Docker:

```sh
cd container
./build.sh
cd ..
```

Verify:

```sh
file emulator/libablspi_shim.so
```

It must be a Linux ARM64/AArch64 `.so`.

### 3. Create The SSH-Ready Raspberry Image

From the repository root:

```sh
./raspberry/make-image.sh
```

This is equivalent to:

```sh
./raspberry/make-image.sh ~/.ssh/id_rsa.pub \
  local/images/Move-Image-2.0.5.img \
  local/images/Move-Image-2.0.5-pi4.img
```

`make-image.sh`:

- clones the original image;
- finds the `/data` partition from the MBR;
- injects your public SSH key into `/authorized_keys`;
- writes the output image:

```text
local/images/Move-Image-2.0.5-pi4.img
```

### 4. Write The microSD And Boot

Write this image to the microSD card:

```text
local/images/Move-Image-2.0.5-pi4.img
```

Then boot the Raspberry Pi 4.

### 5. Connect Over USB And SSH

Connect the Raspberry Pi 4 to the computer over USB. The Move image exposes a
USB network interface at:

```text
172.16.254.1
```

Verify SSH access:

```sh
ssh root@172.16.254.1 'uname -a; id; hostname'
```

Accept the host key if this is the first connection.

### 6. Install Node.js On The Pi

On your computer:

```sh
curl -LO https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-arm64.tar.xz
scp node-v20.18.1-linux-arm64.tar.xz root@172.16.254.1:/data/
```

On the Pi:

```sh
ssh root@172.16.254.1 '
  cd /data &&
  tar -xf node-v20.18.1-linux-arm64.tar.xz &&
  /data/node-v20.18.1-linux-arm64/bin/node --version
'
```

### 7. Copy Runtime Files To The Pi

Create runtime directories:

```sh
ssh root@172.16.254.1 '
  mkdir -p /emulator/input /emulator/spi /data/emulator-gui
'
```

Copy the shim and native launcher:

```sh
scp emulator/libablspi_shim.so root@172.16.254.1:/emulator/libablspi_shim.so
scp raspberry/start-native.sh root@172.16.254.1:/emulator/start-native.sh
```

Copy the server, libraries, and frontend:

```sh
scp emulator/server.mjs root@172.16.254.1:/data/emulator-gui/server.mjs
scp -r emulator/lib root@172.16.254.1:/data/emulator-gui/lib
scp -r emulator/public root@172.16.254.1:/data/emulator-gui/public
```

Set permissions:

```sh
ssh root@172.16.254.1 '
  chmod 755 /emulator/libablspi_shim.so /emulator/start-native.sh &&
  chown -R root:root /emulator /data/emulator-gui
'
```

### 8. Start Move + GUI On The Pi

```sh
ssh root@172.16.254.1 '/emulator/start-native.sh'
```

Then open:

```text
http://172.16.254.1:9090
```

### 9. Verify The Raspberry Runtime

Status:

```sh
curl http://172.16.254.1:9090/api/status
```

Expected:

```json
{"bridge":"running"}
```

Display:

```sh
curl http://172.16.254.1:9090/api/display
```

Expected:

```json
{"available":true,"width":128,"height":64}
```

Audio growth:

```sh
ssh root@172.16.254.1 '
  s1=$(wc -c < /emulator/spi/audio.raw 2>/dev/null || echo 0)
  sleep 3
  s2=$(wc -c < /emulator/spi/audio.raw 2>/dev/null || echo 0)
  echo audio_delta=$((s2-s1))
'
```

The delta should increase. Approximate target for 44.1 kHz stereo 16-bit PCM:

```text
~176400 B/s
```

### 10. Optional Autostart On The Pi

Create an init script:

```sh
ssh root@172.16.254.1 'cat > /etc/init.d/move-native-emulator <<'"'"'SH'"'"'
#!/bin/sh
case "$1" in
  start)
    /emulator/start-native.sh >/tmp/move-native-start.log 2>&1 &
    ;;
  stop)
    killall Move Move.nocap MoveLauncher node 2>/dev/null || true
    ;;
  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;
esac
SH
chmod 755 /etc/init.d/move-native-emulator'
```

If the image uses SysV init, link the script into the appropriate runlevel
directory, for example:

```sh
ssh root@172.16.254.1 '
  ln -sfn ../init.d/move-native-emulator /etc/rc5.d/S99move-native-emulator
'
```

## Files Ignored By Git

The project expects local build/runtime artifacts, but they must not be
published:

```text
local/
emulator/libablspi_shim.so
rootfs/
*.img
*.pdf
*.log
```

The public repository should contain only source, scripts, tests, and
documentation.

## Development Checks

Run the JavaScript tests:

```sh
node --test emulator/tests/*.test.mjs
```

Check shell script syntax:

```sh
sh -n emulator/build-shim.sh \
  container/build.sh container/run-move.sh container/entrypoint.sh \
  raspberry/make-image.sh raspberry/start-native.sh
```

Build the shim manually:

```sh
./emulator/build-shim.sh
```

Local build output:

```text
emulator/libablspi_shim.so
```

The compiled `.so` is ignored by Git.

## Verified Status

Verified on 2026-07-04:

- Move binaries start in the Linux ARM64 container;
- XMOS handshake completes;
- `Move` reads the Core Library and stays alive;
- GUI is available at `http://localhost:9090`;
- display is available through `/api/display`;
- audio stream is active through `/emulator/spi/audio.raw`;
- PCM becomes non-zero after `Play` on the demo set.

The Raspberry Pi flow uses the same shim, server, and frontend, but final
hardware behavior depends on the Pi, microSD, USB networking, and the local
Move image used to build the card.
