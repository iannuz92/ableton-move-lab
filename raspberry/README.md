# Raspberry Pi 4 Image

Procedura per partire da un clone GitHub del repo e da una immagine originale
Ableton Move locale, poi ottenere una microSD Raspberry Pi 4 con Move + GUI web.

Il repo non contiene binari Ableton o immagini `.img`.

## Prerequisiti

- Raspberry Pi 4.
- microSD.
- Immagine originale:

```text
local/images/Move-Image-2.0.5.img
```

Download ufficiale Ableton:

```text
https://www.ableton.com/download/hardware/latest/move/recovery/
```

- Chiave SSH pubblica locale:

```text
~/.ssh/id_rsa.pub
```

- `e2fsprogs` su macOS:

```sh
brew install e2fsprogs
```

- Tool per scrivere la microSD, per esempio Raspberry Pi Imager o `dd`.
- Rete verso il Pi su `172.16.254.1`, come l'immagine Move espone di default.

## 1. Compilare Lo Shim

Se esiste gia':

```text
emulator/libablspi_shim.so
```

puoi saltare questo passaggio.

Altrimenti:

```sh
./emulator/build-shim.sh
```

Su Mac senza toolchain ARM64 Linux, il modo piu' semplice e' fare prima il build
container, che compila lo shim con Docker:

```sh
cd container
./build.sh
cd ..
```

Verifica attesa:

```sh
file emulator/libablspi_shim.so
```

Deve essere un `.so` Linux ARM64/AArch64.

## 2. Creare Immagine SSH-Ready

Da root repo:

```sh
./raspberry/make-image.sh
```

Equivale a:

```sh
./raspberry/make-image.sh ~/.ssh/id_rsa.pub \
  local/images/Move-Image-2.0.5.img \
  local/images/Move-Image-2.0.5-pi4.img
```

Lo script:

- clona l'immagine originale;
- trova la partizione `/data` dalla MBR;
- inserisce la tua chiave pubblica in `/authorized_keys`;
- produce:

```text
local/images/Move-Image-2.0.5-pi4.img
```

## 3. Scrivere La microSD

Scrivere:

```text
local/images/Move-Image-2.0.5-pi4.img
```

sulla microSD.

Avviare il Raspberry Pi 4.

## 4. Primo Accesso SSH

Verifica:

```sh
ssh root@172.16.254.1 'uname -a; id; hostname'
```

Se la host key e' nuova, accettarla.

## 5. Installare Node.js Sul Pi

Sul computer:

```sh
curl -LO https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-arm64.tar.xz
scp node-v20.18.1-linux-arm64.tar.xz root@172.16.254.1:/data/
```

Sul Pi:

```sh
ssh root@172.16.254.1 '
  cd /data &&
  tar -xf node-v20.18.1-linux-arm64.tar.xz &&
  /data/node-v20.18.1-linux-arm64/bin/node --version
'
```

## 6. Copiare Runtime Dalla Repo

Creare cartelle:

```sh
ssh root@172.16.254.1 '
  mkdir -p /emulator/input /emulator/spi /data/emulator-gui
'
```

Copiare shim e script nativo:

```sh
scp emulator/libablspi_shim.so root@172.16.254.1:/emulator/libablspi_shim.so
scp raspberry/start-native.sh root@172.16.254.1:/emulator/start-native.sh
```

Copiare server, librerie e frontend:

```sh
scp emulator/server.mjs root@172.16.254.1:/data/emulator-gui/server.mjs
scp -r emulator/lib root@172.16.254.1:/data/emulator-gui/lib
scp -r emulator/public root@172.16.254.1:/data/emulator-gui/public
```

Permessi:

```sh
ssh root@172.16.254.1 '
  chmod 755 /emulator/libablspi_shim.so /emulator/start-native.sh &&
  chown -R root:root /emulator /data/emulator-gui
'
```

## 7. Avviare Move + GUI

Sul Pi:

```sh
ssh root@172.16.254.1 '/emulator/start-native.sh'
```

Poi aprire:

```text
http://172.16.254.1:9090
```

## 8. Verifiche

Stato:

```sh
curl http://172.16.254.1:9090/api/status
```

Atteso:

```json
{"bridge":"running"}
```

Display:

```sh
curl http://172.16.254.1:9090/api/display
```

Atteso:

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

Il delta deve crescere. Target indicativo per PCM stereo 44.1 kHz 16-bit:

```text
~176400 B/s
```

## 9. Avvio Automatico Opzionale

Creare init script:

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

Se l'immagine usa SysV init, collegare lo script nella runlevel directory
appropriata, per esempio:

```sh
ssh root@172.16.254.1 '
  ln -sfn ../init.d/move-native-emulator /etc/rc5.d/S99move-native-emulator
'
```

## File Coinvolti

Dal repo vengono usati:

```text
raspberry/make-image.sh
raspberry/start-native.sh
emulator/libablspi_shim.so
emulator/server.mjs
emulator/lib/
emulator/public/
```

Fuori dal Git servono:

```text
local/images/Move-Image-2.0.5.img
node-v20.18.1-linux-arm64.tar.xz
```
