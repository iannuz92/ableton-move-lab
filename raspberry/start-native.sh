#!/bin/sh
set -eu

NODE_BIN="${NODE_BIN:-/data/node-v20.18.1-linux-arm64/bin/node}"
GUI_DIR="${GUI_DIR:-/data/emulator-gui}"
SHIM="${SHIM:-/emulator/libablspi_shim.so}"
MOVE_NOCAP="${MOVE_NOCAP:-/emulator/Move.nocap}"

mkdir -p /emulator/input /emulator/spi
chown -R ableton:root /emulator/input /emulator/spi 2>/dev/null || true

for name in Move Move.nocap MoveLauncher MoveControlModeHandler MoveSentryRunProcessor; do
  pids=$(pidof "$name" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill -9 $pids 2>/dev/null || true
  fi
done

node_pids=$(pidof node 2>/dev/null || true)
if [ -n "$node_pids" ]; then
  kill $node_pids 2>/dev/null || true
fi
sleep 1

if [ -e /dev/ablspi0.0.real ]; then
  rm -f /dev/ablspi0.0
  mv /dev/ablspi0.0.real /dev/ablspi0.0
fi

cp /opt/move/Move "$MOVE_NOCAP"
chmod 755 "$MOVE_NOCAP"
chown root:root "$MOVE_NOCAP"
setcap -r "$MOVE_NOCAP" 2>/dev/null || true

rm -f /emulator/input/midi.bin
rm -f /emulator/input/events.ndjson
rm -f /emulator/spi/tx-packets.bin
rm -f /emulator/spi/rx-packets.bin
rm -f /emulator/spi/audio.raw
rm -f /emulator/spi/script.log
rm -f /emulator/spi/xmos-dbg.log
rm -f /emulator/spi/handshake.log
rm -f /emulator/spi/force-display.log
rm -f /emulator/spi/ablspi0.0

(
  cd "$GUI_DIR"
  nohup "$NODE_BIN" server.mjs > "$GUI_DIR/server.log" 2>&1 &
)

su ableton -c "MOVE_XMOS_DEVINFO=1 MOVE_XMOS_SCRIPT=battery-full MOVE_XMOS_CAPTURE_RX=0 LD_PRELOAD=$SHIM /opt/move/MoveLauncher >/tmp/move-launcher-native.log 2>&1 &"

attempts=0
while ! grep -q 'MoveFirmwareAutoUpdater quit with code 0' /tmp/move-launcher-native.log 2>/dev/null; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 100 ]; then
    echo "XMOS firmware handshake did not complete" >&2
    tail -80 /tmp/move-launcher-native.log >&2 || true
    exit 1
  fi
  sleep 0.1
done

MOVE_XMOS_TRANSFER_US=0 \
MOVE_XMOS_DEVINFO=1 \
MOVE_XMOS_SCRIPT=battery-full \
MOVE_XMOS_CAPTURE_RX=0 \
MOVE_XMOS_FORCE_DISPLAY=1 \
MOVE_AUDIO_STREAM=1 \
LD_PRELOAD="$SHIM" \
"$MOVE_NOCAP" \
  --user-data-dir /data/UserData \
  --settings-dir /data/UserData/settings \
  --sentry-database-dir "" \
  --crashpad-handler-path "" \
  --userlib-dir /data/UserData/UserLibrary \
  --scratch-dir /data/UserData/Scratch \
  --log-level error >/tmp/move-native.log 2>&1 &

sleep 3
printf "\013\260\061\177" >> /emulator/input/midi.bin
sleep 0.2
printf "\013\260\061\000" >> /emulator/input/midi.bin

echo "Move native stack started"
echo "GUI: http://0.0.0.0:9090"
