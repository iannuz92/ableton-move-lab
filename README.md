# Ableton Move Lab

This repository contains the open tooling needed to run the Ableton Move
software stack with a browser-based control surface.

The repository intentionally contains only scripts, shim source code, the Node
server, the browser UI, tests, and engineering notes. It does **not** contain:

- Ableton Move `.img` files;
- proprietary Ableton binaries;
- proprietary manuals or PDFs;
- extracted root filesystems;
- runtime logs or captures.

Anyone cloning the repository must download the original Move recovery image
locally and place it here:

```text
local/images/Move-Image-2.0.5.img
```

Official Ableton recovery download:

```text
https://www.ableton.com/download/hardware/latest/move/recovery/
```

`local/images/` is ignored by Git.

## Supported Targets

There are two supported ways to use the project.

### 1. Linux ARM64 Container

Fastest path for running Move on Apple Silicon with the web GUI:

```sh
cd container
./build.sh
./run-move.sh
```

Then open:

```text
http://localhost:9090
```

`container/build.sh` starts from the original Move image and creates a complete
Docker runtime:

- extracts the root filesystem and `/data` partition from the Move image;
- creates the Docker image `move-rootfs:latest`;
- creates and populates the Docker volume `move-data-vol`;
- compiles `emulator/shim/ablspi_shim.c` into `emulator/libablspi_shim.so` if needed;
- injects the shim into `/emulator/libablspi_shim.so`;
- injects the GUI and server into `/data/emulator-gui`;
- installs ARM64 Node.js into `/data` if needed.

Full guide:

```text
container/README.md
```

### 2. Raspberry Pi 4

Path for creating a bootable Raspberry Pi 4 microSD image that runs Move
natively with the same web GUI.

Start from the repository root:

```sh
./raspberry/make-image.sh
```

Default output:

```text
local/images/Move-Image-2.0.5-pi4.img
```

Then follow:

```text
raspberry/README.md
```

The Raspberry guide covers:

- image preparation;
- first boot;
- SSH access;
- shim copy;
- Node.js installation;
- server/frontend copy;
- `/emulator/start-native.sh` installation;
- startup and GUI verification at `http://172.16.254.1:9090`.

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
  README.md               # complete container guide

raspberry/
  make-image.sh           # prepares a Raspberry Pi image from the local Move image
  start-native.sh         # native runtime launcher for the Pi
  README.md               # complete Raspberry guide
```

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
