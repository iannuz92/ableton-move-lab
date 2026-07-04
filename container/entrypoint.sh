#!/bin/sh
# Entrypoint del container: avvia lo stack Move emulato (shim XMOS) + GUI web.
# Gira dentro l'immagine "move-rootfs" (la rootfs del Move) con /data montato.
set -eu

SHIM=/emulator/libablspi_shim.so
NODE_VERSION="${NODE_VERSION:-v20.18.1}"
NODE_BIN="${NODE_BIN:-/data/node-$NODE_VERSION-linux-arm64/bin/node}"
GUI_DIR=/data/emulator-gui
MOVE_NOCAP=/emulator/Move.nocap

log() { echo "[entrypoint] $*"; }

# --- D-Bus system bus (serve a MoveLauncher/Move) ---
mkdir -p /run/dbus /var/lib/dbus
dbus-uuidgen > /etc/machine-id 2>/dev/null || true
dbus-uuidgen --ensure=/var/lib/dbus/machine-id 2>/dev/null || true
dbus-daemon --system --fork 2>/dev/null || true
log "dbus avviato"

# --- ConnMan + Avahi: Move NON resta vivo senza net.connman sul bus ---
connmand 2>/dev/null &
avahi-daemon -D 2>/dev/null || true
log "connman + avahi avviati"

# --- SWUpdate IPC: Move e ControlModeHandler aspettano /tmp/swupdateprog ---
/usr/bin/swupdate -f /etc/swupdate/swupdate.conf -l 4 >/tmp/swupdate.log 2>&1 &
i=0
while [ "$i" -lt 50 ]; do
  if [ -S /tmp/swupdateprog ] && [ -S /tmp/sockinstctrl ]; then
    log "swupdate IPC avviato"
    break
  fi
  i=$((i + 1))
  sleep 0.1
done
if [ ! -S /tmp/swupdateprog ] || [ ! -S /tmp/sockinstctrl ]; then
  log "warning: swupdate IPC non pronto; Move potrebbe restare in attesa"
  tail -40 /tmp/swupdate.log 2>/dev/null || true
fi

# --- placeholder del device SPI (sul Pi lo crea il driver ablspi) ---
touch /dev/ablspi0.0 2>/dev/null || true
chown ableton /dev/ablspi0.0 2>/dev/null || true

# --- directory di lavoro dello shim ---
mkdir -p /emulator/input /emulator/spi
chown -R ableton:root /emulator/input /emulator/spi 2>/dev/null || true
chmod 777 /tmp

# --- seed demo opzionale: volume e set corrente udibili su un volume nuovo ---
if [ "${MOVE_CONTAINER_DEMO_AUDIO:-1}" != "0" ] && [ -f /data/UserData/settings/Settings.json ]; then
  if grep -q '"currentSongIndex": -1' /data/UserData/settings/Settings.json; then
    sed -i 's/"currentSongIndex": -1/"currentSongIndex": 1/' /data/UserData/settings/Settings.json
    log "currentSongIndex impostato a 1 per caricare un demo set"
  fi
  if grep -q '"globalVolume": 0\.0' /data/UserData/settings/Settings.json; then
    sed -i 's/"globalVolume": 0\.0/"globalVolume": 0.8/' /data/UserData/settings/Settings.json
    log "globalVolume impostato a 0.8 per abilitare audio udibile"
  fi
fi

# --- copia non-capability del motore (come start-native.sh) ---
cp /opt/move/Move "$MOVE_NOCAP"
chmod 755 "$MOVE_NOCAP"
chown ableton "$MOVE_NOCAP" 2>/dev/null || true

# pulizia stato precedente
rm -f /emulator/input/midi.bin /emulator/spi/audio.raw \
      /emulator/spi/tx-packets.bin /emulator/spi/rx-packets.bin \
      /emulator/spi/script.log 2>/dev/null || true

# --- GUI web (Node) su :9090, se presente in /data ---
if [ -x "$NODE_BIN" ] && [ -f "$GUI_DIR/server.mjs" ]; then
  ( cd "$GUI_DIR" && nohup "$NODE_BIN" server.mjs > /tmp/gui.log 2>&1 & )
  log "GUI web avviata su :9090"
else
  log "GUI non trovata in /data (salto): $GUI_DIR"
fi

# --- FASE 1: MoveLauncher, handshake XMOS via shim ---
log "avvio MoveLauncher (handshake XMOS)"
su ableton -s /bin/sh -c "MOVE_XMOS_DEVINFO=1 MOVE_XMOS_SCRIPT=battery-full MOVE_XMOS_CAPTURE_RX=0 LD_PRELOAD=$SHIM /opt/move/MoveLauncher > /tmp/move-launcher.log 2>&1 &"

# attende il completamento dell'handshake (o prosegue dopo timeout)
i=0
while [ "$i" -lt 300 ]; do
  if grep -q "MoveFirmwareAutoUpdater quit with code 0" /tmp/move-launcher.log 2>/dev/null; then
    log "handshake XMOS completato"
    break
  fi
  i=$((i + 1))
  sleep 0.1
done

# --- FASE 2: motore Move con audio streaming ---
log "avvio motore Move (audio stream)"
su ableton -s /bin/sh -c "MOVE_XMOS_TRANSFER_US=0 MOVE_XMOS_DEVINFO=1 MOVE_XMOS_SCRIPT=battery-full MOVE_XMOS_CAPTURE_RX=0 MOVE_XMOS_FORCE_DISPLAY=1 MOVE_AUDIO_STREAM=1 LD_PRELOAD=$SHIM $MOVE_NOCAP --user-data-dir /data/UserData --settings-dir /data/UserData/settings --userlib-dir /data/UserData/UserLibrary --scratch-dir /data/UserData/Scratch --log-level error > /tmp/move.log 2>&1 &"

sleep 3
printf "\013\260\061\177" >> /emulator/input/midi.bin
sleep 0.2
printf "\013\260\061\000" >> /emulator/input/midi.bin

log "stack avviato. GUI: http://localhost:9090"
log "log: /tmp/move-launcher.log  /tmp/move.log  /tmp/gui.log  /tmp/swupdate.log"

# mantiene vivo il container e mostra i log del motore
sleep 2
touch /tmp/move.log
exec tail -f /tmp/move.log
