# Move Emulator

Web GUI and native shim for running Ableton Move from the original image on a
Raspberry Pi 4.

## Runtime On The Pi

- `/data/emulator-gui/server.mjs`: HTTP API and static file server.
- `/data/emulator-gui/public/`: browser UI.
- `/emulator/libablspi_shim.so`: `LD_PRELOAD` shim for SPI/XMOS/display/LED/audio.
- `/emulator/input/`: GUI-to-engine input files.
- `/emulator/spi/`: shim output captures consumed by the server.

## Folders

- `lib/`: protocol and parsing modules used by the server and tools.
- `public/`: browser UI, audio worklet, and client-side rendering helpers.
- `shim/`: native C shim source.
- `tools/`: reverse-engineering and manual debug utilities.
- `tests/`: Node test suite.
- `docs/`: emulator-specific notes.

## Commands

```sh
node emulator/server.mjs
./emulator/build-shim.sh
node --test emulator/tests/*.test.mjs
```
