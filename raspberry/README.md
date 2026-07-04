# Raspberry Pi 4 Image

This target starts from a GitHub clone of this repository and a local original
Ableton Move recovery image, then produces a Raspberry Pi 4 microSD image that
runs Move with the web GUI.

The repository does not contain Ableton binaries or `.img` files.

## Prerequisites

- Raspberry Pi 4.
- microSD card.
- Local Move recovery image:

```text
local/images/Move-Image-2.0.5.img
```

Official Ableton recovery download:

```text
https://www.ableton.com/download/hardware/latest/move/recovery/
```

- Local SSH public key:

```text
~/.ssh/id_rsa.pub
```

- `e2fsprogs` and `fdisk`/`util-linux` tools.

macOS:

```sh
brew install e2fsprogs
```

Debian/Ubuntu Linux:

```sh
sudo apt-get install e2fsprogs fdisk
```

This provides `debugfs` and `e2fsck`. `make-image.sh` uses them to edit and
check the ext `/data` partition inside the Move image without mounting it.

- A tool for writing the microSD card, such as Raspberry Pi Imager or `dd`.
- USB network access to the Pi at `172.16.254.1`. This is the default
  Move/Raspberry USB gadget address, not a Wi-Fi or Ethernet address.

## 1. Build The Shim

If this file already exists:

```text
emulator/libablspi_shim.so
```

you can skip this step.

Otherwise run:

```sh
./emulator/build-shim.sh
```

On a host without a Linux ARM64 toolchain, the simplest path is to run the
container build first. It compiles the shim with Docker:

```sh
cd container
./build.sh
cd ..
```

Expected verification:

```sh
file emulator/libablspi_shim.so
```

It must be a Linux ARM64/AArch64 `.so`.

## 2. Create The SSH-Ready Image

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

The script:

- clones the original image;
- finds the `/data` partition from the MBR;
- injects your public SSH key into `/authorized_keys`;
- produces:

```text
local/images/Move-Image-2.0.5-pi4.img
```

## 3. Write The microSD

Write this image to the microSD card:

```text
local/images/Move-Image-2.0.5-pi4.img
```

Then boot the Raspberry Pi 4.

## 4. First SSH Login

Connect the Raspberry Pi 4 to the computer over USB. The Move image exposes a
USB network interface at:

```text
172.16.254.1
```

Verify access:

```sh
ssh root@172.16.254.1 'uname -a; id; hostname'
```

Accept the host key if this is the first connection.

## 5. Install Node.js On The Pi

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

## 6. Copy The Runtime From The Repository

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

## 7. Start Move + GUI

On the Pi:

```sh
ssh root@172.16.254.1 '/emulator/start-native.sh'
```

Then open:

```text
http://172.16.254.1:9090
```

## 8. Verification

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

Audio:

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

## 9. Optional Autostart

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

## Files Used

From the repository:

```text
raspberry/make-image.sh
raspberry/start-native.sh
emulator/libablspi_shim.so
emulator/server.mjs
emulator/lib/
emulator/public/
```

Outside Git:

```text
local/images/Move-Image-2.0.5.img
node-v20.18.1-linux-arm64.tar.xz
```
