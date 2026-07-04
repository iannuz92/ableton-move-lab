# Move Container

Esegue Ableton Move dentro un container **Linux ARM64** su Mac Apple Silicon,
usando l'immagine originale Move e lo shim `libablspi_shim.so` per emulare
hardware XMOS/SPI.

## Prerequisiti

- Docker Desktop attivo.
- Connessione internet al primo build, per scaricare:
  - immagine builder `ubuntu:22.04`;
  - Node.js ARM64 se non e' gia' presente in `/data`.
- `e2fsprogs` su macOS:

```sh
brew install e2fsprogs
```

- Immagine Move locale:

```text
../local/images/Move-Image-2.0.5.img
```

Download ufficiale Ableton:

```text
https://www.ableton.com/download/hardware/latest/move/recovery/
```

- Shim gia' presente nella rootfs dell'immagine o copiato dal progetto durante
  il build. Se manca, `build.sh` lo compila da:

```text
../emulator/shim/ablspi_shim.c
```

I binari Ableton restano fuori dal Git: `build.sh` li estrae localmente
dall'immagine originale.

## Avvio Completo

Da questa cartella:

```sh
cd container
./build.sh
./run-move.sh
```

Poi aprire:

```text
http://localhost:9090
```

Se l'immagine ha un path diverso:

```sh
./build.sh /percorso/Move-Image-2.0.5.img
./run-move.sh
```

## Cosa Fa `build.sh`

`build.sh` non richiede una immagine gia' patchata. Parte dall'immagine Move
originale e legge la tabella MBR per estrarre:

- partizione rootfs;
- partizione `/data`.

Poi crea:

- immagine Docker `move-rootfs:latest`, importando la rootfs originale Move;
- volume Docker `move-data-vol`, popolato con `/data`.

Poi inietta dal repo:

- `../emulator/libablspi_shim.so` in `/emulator/libablspi_shim.so`;
- `../emulator/server.mjs` in `/data/emulator-gui/server.mjs`;
- `../emulator/lib/` in `/data/emulator-gui/lib/`;
- `../emulator/public/` in `/data/emulator-gui/public/`;
- Node.js ARM64 in `/data/node-v20.18.1-linux-arm64/`, se manca.

Se `../emulator/libablspi_shim.so` non esiste, viene compilato con un container
builder Ubuntu ARM64.

Il volume Docker e' necessario: Move usa **xattr** sui set/songs, e i bind mount
macOS non sono affidabili per questo uso.

## Cosa Fa `run-move.sh`

Avvia un container chiamato `move` con:

- porta `9090` esposta su `localhost`;
- volume `move-data-vol` montato su `/data`;
- `entrypoint.sh` montato read-only;
- capability per scheduling/audio:
  - `SYS_NICE`
  - `IPC_LOCK`
  - `rtprio=99`
  - `memlock=-1`

Variabile utile:

```sh
MOVE_CONTAINER_DEMO_AUDIO=0 ./run-move.sh
```

Disattiva la seed automatica del demo set/volume.

## Cosa Fa `entrypoint.sh`

Dentro il container avvia lo stack completo richiesto dai binari Move:

1. D-Bus system bus.
2. ConnMan.
3. Avahi.
4. SWUpdate IPC:
   - `/tmp/swupdateprog`
   - `/tmp/sockinstctrl`
5. Placeholder device:
   - `/dev/ablspi0.0`
6. Directory shim:
   - `/emulator/input`
   - `/emulator/spi`
7. GUI Node:
   - `/data/emulator-gui/server.mjs`
8. `MoveLauncher` con `LD_PRELOAD=/emulator/libablspi_shim.so`.
9. Attesa handshake XMOS:
   - `MoveFirmwareAutoUpdater quit with code 0`
10. Motore `Move.nocap` con:
   - `MOVE_AUDIO_STREAM=1`
   - `MOVE_XMOS_DEVINFO=1`
   - `MOVE_XMOS_FORCE_DISPLAY=1`
   - `LD_PRELOAD=/emulator/libablspi_shim.so`
11. Tap Shift iniziale per svegliare display/engine, come nel setup Raspberry.

Se `MOVE_CONTAINER_DEMO_AUDIO` non e' `0`, l'entrypoint rende il primo avvio
subito udibile:

- se `currentSongIndex` e' `-1`, lo porta a `1`;
- se `globalVolume` e' `0.0`, lo porta a `0.8`.

## Perche' Serve SWUpdate

Questo e' stato il pezzo decisivo.

Senza SWUpdate IPC, `Move` e `MoveControlModeHandler` restano vivi ma fanno
polling continuo su:

```text
/tmp/swupdateprog
```

e il loop audio/SPI non parte. Sintomo:

- GUI HTTP 200;
- processo `Move` vivo;
- handshake XMOS completato;
- `audio.raw` fermo o assente.

Con SWUpdate attivo:

- `/tmp/swupdateprog` esiste;
- `/tmp/sockinstctrl` esiste;
- `/emulator/spi/audio.raw` cresce;
- `/emulator/spi/tx-packets.bin` cresce;
- display e audio passano dalla GUI.

## Verifiche

Stato container:

```sh
docker ps --filter name=move
```

API GUI:

```sh
curl http://localhost:9090/api/status
```

Atteso:

```json
{"bridge":"running"}
```

Display:

```sh
curl http://localhost:9090/api/display
```

Atteso:

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

Il file deve crescere. Target indicativo:

```text
~176400 B/s
```

PCM non-zero dopo `Play`:

```sh
curl -X POST http://localhost:9090/api/control \
  -H 'content-type: application/json' \
  -d '{"type":"button","id":"play","action":"press"}'

curl -X POST http://localhost:9090/api/control \
  -H 'content-type: application/json' \
  -d '{"type":"button","id":"play","action":"release"}'
```

Poi controllare l'ultimo secondo di audio:

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

Con demo set e volume attivi, `nonzero` deve essere alto.

## Log Utili

Dentro il container:

```sh
docker exec -it move sh
```

Log principali:

```text
/tmp/move-launcher.log
/tmp/move.log
/tmp/gui.log
/tmp/swupdate.log
```

File prodotti dallo shim:

```text
/emulator/spi/tx-packets.bin
/emulator/spi/audio.raw
/emulator/spi/script.log
/emulator/input/midi.bin
```

## Reset

Riavviare solo il container:

```sh
./run-move.sh
```

Ricostruire da zero immagine Docker e volume:

```sh
docker rm -f move 2>/dev/null || true
docker volume rm move-data-vol 2>/dev/null || true
docker image rm move-rootfs:latest 2>/dev/null || true
./build.sh
./run-move.sh
```

## Stato Verificato

Verificato il 2026-07-04:

- binari Move avviati in Linux ARM64;
- handshake XMOS completato;
- `Move` legge Core Library e resta vivo;
- GUI disponibile su `http://localhost:9090`;
- display disponibile via `/api/display`;
- audio stream attivo via `/emulator/spi/audio.raw`;
- PCM non-zero dopo `Play` su demo set.
