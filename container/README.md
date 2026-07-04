# Move Container

This target runs Ableton Move inside a **Linux ARM64** container, using the
original Move image and `libablspi_shim.so` to emulate the XMOS/SPI hardware
boundary.

It is tested on Apple Silicon, but it is not Mac-only. ARM64 Linux hosts can run
it natively. x86_64 Linux hosts need Docker/QEMU binfmt support for
`linux/arm64`, and performance may be slower.

## Prerequisites

- Docker Engine or Docker Desktop running with `linux/arm64` support.
- Internet access for the first build, to download:
  - the `ubuntu:22.04` builder image;
  - ARM64 Node.js if it is not already present in `/data`.
- `e2fsprogs` and `fdisk`/`util-linux` tools.

macOS:

```sh
brew install e2fsprogs
```

Debian/Ubuntu Linux:

```sh
sudo apt-get install e2fsprogs fdisk
```

This provides `debugfs`, which `build.sh` uses to read files from the ext
partitions inside the original Move image without mounting them.

- Local Move recovery image:

```text
../local/images/Move-Image-2.0.5.img
```

Official Ableton recovery download:

```text
https://www.ableton.com/download/hardware/latest/move/recovery/
```

Ableton binaries remain outside Git. `build.sh` extracts them locally from the
original recovery image.

## Complete Startup

From this directory:

```sh
cd container
./build.sh
./run-move.sh
```

Then open:

```text
http://localhost:9090
```

If the image is stored somewhere else:

```sh
./build.sh /path/to/Move-Image-2.0.5.img
./run-move.sh
```

## What `build.sh` Does

`build.sh` does not require a pre-patched image. It starts from the original
Move recovery image and reads the MBR partition table to extract:

- the root filesystem partition;
- the `/data` partition.

It then creates:

- Docker image `move-rootfs:latest`, imported from the original Move rootfs;
- Docker volume `move-data-vol`, populated with the original `/data` contents.

It injects the open files from this repository:

- `../emulator/libablspi_shim.so` into `/emulator/libablspi_shim.so`;
- `../emulator/server.mjs` into `/data/emulator-gui/server.mjs`;
- `../emulator/lib/` into `/data/emulator-gui/lib/`;
- `../emulator/public/` into `/data/emulator-gui/public/`;
- ARM64 Node.js into `/data/node-v20.18.1-linux-arm64/`, if missing.

If `../emulator/libablspi_shim.so` does not exist, it is compiled with an ARM64
Ubuntu builder container from:

```text
../emulator/shim/ablspi_shim.c
```

The Docker volume is required because Move uses **xattr** on sets/songs. A
Docker-managed volume is more reliable for this workload than host bind mounts,
especially on macOS.

## What `run-move.sh` Does

`run-move.sh` starts a container named `move` with:

- port `9090` exposed on `localhost`;
- Docker volume `move-data-vol` mounted at `/data`;
- `entrypoint.sh` mounted read-only;
- scheduling/audio capabilities:
  - `SYS_NICE`
  - `IPC_LOCK`
  - `rtprio=99`
  - `memlock=-1`

Useful variable:

```sh
MOVE_CONTAINER_DEMO_AUDIO=0 ./run-move.sh
```

This disables the automatic demo set/volume seed.

## What `entrypoint.sh` Does

Inside the container, `entrypoint.sh` starts the full service stack expected by
the Move binaries:

1. D-Bus system bus.
2. ConnMan.
3. Avahi.
4. SWUpdate IPC:
   - `/tmp/swupdateprog`
   - `/tmp/sockinstctrl`
5. Placeholder device:
   - `/dev/ablspi0.0`
6. Shim working directories:
   - `/emulator/input`
   - `/emulator/spi`
7. Node GUI:
   - `/data/emulator-gui/server.mjs`
8. `MoveLauncher` with `LD_PRELOAD=/emulator/libablspi_shim.so`.
9. XMOS handshake wait:
   - `MoveFirmwareAutoUpdater quit with code 0`
10. `Move.nocap` engine with:
   - `MOVE_AUDIO_STREAM=1`
   - `MOVE_XMOS_DEVINFO=1`
   - `MOVE_XMOS_FORCE_DISPLAY=1`
   - `LD_PRELOAD=/emulator/libablspi_shim.so`
11. Initial Shift tap to wake the display/engine, matching the Raspberry setup.

Unless `MOVE_CONTAINER_DEMO_AUDIO=0`, the first run is made immediately audible:

- if `currentSongIndex` is `-1`, it is changed to `1`;
- if `globalVolume` is `0.0`, it is changed to `0.8`.

## Why SWUpdate Is Required

SWUpdate IPC is required for the Move engine to enter the active SPI/audio loop.

Without SWUpdate IPC, `Move` and `MoveControlModeHandler` stay alive but keep
polling:

```text
/tmp/swupdateprog
```

Symptoms:

- GUI returns HTTP 200;
- `Move` process is alive;
- XMOS handshake completes;
- `audio.raw` is missing or does not grow.

With SWUpdate running:

- `/tmp/swupdateprog` exists;
- `/tmp/sockinstctrl` exists;
- `/emulator/spi/audio.raw` grows;
- `/emulator/spi/tx-packets.bin` grows;
- display and audio are available through the GUI.

## Verification

Container status:

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

Audio rate:

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

Non-zero PCM after `Play`:

```sh
curl -X POST http://localhost:9090/api/control \
  -H 'content-type: application/json' \
  -d '{"type":"button","id":"play","action":"press"}'

curl -X POST http://localhost:9090/api/control \
  -H 'content-type: application/json' \
  -d '{"type":"button","id":"play","action":"release"}'
```

Then inspect the last second of audio:

```sh
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

With the demo set and volume seed enabled, `nonzero` should be high.

## Useful Logs

Enter the container:

```sh
docker exec -it move sh
```

Main logs:

```text
/tmp/move-launcher.log
/tmp/move.log
/tmp/gui.log
/tmp/swupdate.log
```

Shim output files:

```text
/emulator/spi/tx-packets.bin
/emulator/spi/audio.raw
/emulator/spi/script.log
/emulator/input/midi.bin
```

## Reset

Restart only the container:

```sh
./run-move.sh
```

Rebuild the Docker image and volume from scratch:

```sh
docker rm -f move 2>/dev/null || true
docker volume rm move-data-vol 2>/dev/null || true
docker image rm move-rootfs:latest 2>/dev/null || true
./build.sh
./run-move.sh
```

## Verified Status

Verified on 2026-07-04:

- Move binaries start in Linux ARM64;
- XMOS handshake completes;
- `Move` reads the Core Library and stays alive;
- GUI is available at `http://localhost:9090`;
- display is available through `/api/display`;
- audio stream is active through `/emulator/spi/audio.raw`;
- PCM becomes non-zero after `Play` on the demo set.
