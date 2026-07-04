# Ableton Move Lab

Repo per far girare Ableton Move con una GUI web usando l'immagine originale
Ableton Move.

Il Git contiene solo script, shim, server e frontend. Non contiene:

- immagini `.img`;
- binari proprietari Ableton;
- manuali/PDF proprietari;
- rootfs estratte;
- log/capture runtime.

Chi clona il repo deve procurarsi localmente l'immagine originale Move e
metterla qui:

```text
local/images/Move-Image-2.0.5.img
```

Download ufficiale Ableton:

```text
https://www.ableton.com/download/hardware/latest/move/recovery/
```

`local/images/` e' ignorata da Git.

## Percorsi Supportati

Ci sono due modi per usare il progetto.

### 1. Container Linux ARM64

Percorso piu' rapido per provare Move su Mac Apple Silicon con GUI web:

```sh
cd container
./build.sh
./run-move.sh
```

Poi aprire:

```text
http://localhost:9090
```

`container/build.sh` parte dall'immagine originale e crea un ambiente
Docker completo:

- estrae rootfs e `/data` dall'immagine Move;
- crea l'immagine Docker `move-rootfs:latest`;
- crea/popola il volume Docker `move-data-vol`;
- compila `emulator/shim/ablspi_shim.c` in `emulator/libablspi_shim.so` se manca;
- inietta lo shim in `/emulator/libablspi_shim.so`;
- inietta GUI e server in `/data/emulator-gui`;
- installa Node.js ARM64 in `/data` se manca.

Guida completa:

```text
container/README.md
```

### 2. Raspberry Pi 4

Percorso per creare una microSD avviabile su Raspberry Pi 4 e far girare Move
nativamente con la stessa GUI web.

Partenza:

```sh
./raspberry/make-image.sh
```

Output predefinito:

```text
local/images/Move-Image-2.0.5-pi4.img
```

Poi seguire la guida:

```text
raspberry/README.md
```

La guida Raspberry copre:

- preparazione immagine;
- primo boot;
- SSH;
- copia shim;
- installazione Node;
- copia server/frontend;
- installazione script `/emulator/start-native.sh`;
- avvio e verifica della GUI su `http://172.16.254.1:9090`.

## Struttura

```text
emulator/
  server.mjs              # API + static server GUI
  public/                 # frontend browser
  lib/                    # parser/protocollo display, LED, MIDI, audio
  shim/                   # sorgente C LD_PRELOAD
  tools/                  # reverse/debug manuale
  tests/                  # test Node
  docs/                   # note tecniche emulator

container/
  build.sh                # crea container completo dall'immagine originale
  run-move.sh             # avvia container
  entrypoint.sh           # avvia servizi + Move nel container
  README.md               # guida completa container

raspberry/
  make-image.sh           # prepara immagine Pi da immagine Move locale
  start-native.sh         # runtime nativo sul Pi
  README.md               # guida completa Raspberry
```

## Verifiche Sviluppo

Test JS:

```sh
node --test emulator/tests/*.test.mjs
```

Controllo script shell:

```sh
sh -n emulator/build-shim.sh \
  container/build.sh container/run-move.sh container/entrypoint.sh \
  raspberry/make-image.sh raspberry/start-native.sh
```

Compilare lo shim manualmente:

```sh
./emulator/build-shim.sh
```

Il risultato locale e':

```text
emulator/libablspi_shim.so
```

Il file compilato e' ignorato da Git.
