# Move MIDI Mapping Reverse Notes

Data collected on 2026-06-29 using the Ableton `rootfs/opt/move/Move` binary
as the runtime oracle. The emulator mapping was not used as a source:
`emulator/tools/reverse-midi-scan.mjs` writes raw USB-MIDI packets into
`emulator/input/midi.bin` and reads `emulator/spi/tx-packets.bin` directly with
the local display/LED parsers.

## Sources

- Binary: `rootfs/opt/move/Move`
- Private/local documents:
  - Move USB MIDI chart
  - Ableton Move manual
- Captures:
  - `emulator/reverse-captures/2026-06-29T13-52-18-469Z-known.jsonl`
  - `emulator/reverse-captures/2026-06-29T13-53-14-881Z-scan-cc.jsonl`
  - `emulator/reverse-captures/2026-06-29T13-54-41-181Z-scan-notes.jsonl`

## Strong Runtime Confirmations

These raw messages produced display and/or LED changes from the binary:

| Control | MIDI | Runtime evidence |
| --- | --- | --- |
| Wheel press/click | CC `0x03` press/release | display changed, LED diffs |
| Wheel rotate | CC `0x0e`, `0x01`/`0x7f` relative | display changed |
| Wheel touch | Note `0x09` on/off | display changed in note scan |
| Volume touch | Note `0x08` on/off | display changed in note scan |
| Track 4..1 | CC `0x28..0x2b` | display changed, matching track LED CCs |
| Mode | CC `0x32` | display and LED changed |
| Capture | CC `0x34` | display changed |
| Encoder rotate | CC `0x47..0x4f` | display changed for tested range |
| Play | CC `0x55` | display changed, LED CC `0x55` changed |
| Record | CC `0x56` | LED CC `0x56` changed |
| Mute | CC `0x58` | display changed, transport LEDs changed |
| Sample | CC `0x76` | display changed |
| Delete | CC `0x77` | display changed |
| Step buttons | Note `0x10..0x1f` | known scan changed display for `0x10`, `0x1f` |
| Pads | Note `0x44..0x63` | known scan changed display for `0x44`, `0x5c` |

## Internal Event Names

- Wheel rotation is `type: "wheel"` and emits CC `0x0e`.
- Wheel pressure/click is `type: "button", id: "wheelPress"` and emits CC
  `0x03`.
- Wheel capacitive touch is `type: "touch", id: "wheel"` and emits note
  `0x09`.

## LED Output Observed

- Plain button LEDs are emitted as CC values. Runtime state included CCs
  `0x10..0x1f` for step indicators, plus mapped button CCs such as `0x31`,
  `0x32`, `0x55`, `0x56`, `0x58`, `0x76`, `0x77`.
- RGB LEDs are emitted through SysEx, with IDs matching track/pad/encoder
  identifiers. Track IDs `0x28..0x2b` and encoder IDs `0x47..0x4f` were
  observed.
- Pad/step LEDs are also emitted as note messages: `90 <id> <velocity>` lights
  a pad or step, while `80 <id> 00` and `90 <id> 00` turn it off. Preserve the
  raw velocity because values such as `0`, `3`, `122`, and `126` carry the
  engine's brightness/color semantics.
- Unknown non-dim velocity indices are rendered through a stable preview
  palette in `emulator/lib/led-capture.mjs`, but the raw `noteVelocities` value is
  the authoritative capture. Exact hue matching still needs calibration against
  real hardware or a complete Ableton color-index table.
- Pad velocity values `1..3` are treated by the frontend as dim pads in the
  selected track color. For Drum Rack this prevents available pads from being
  rendered black: the selected track RGB comes from track ids `0x28..0x2b`
  (for example track 1 observed as orange `[255,118,0]`).
- Do not merge all LED feedback into one id namespace for rendering. Pad notes
  `0x47..0x4f` overlap the encoder/ring RGB ids `0x47..0x4f`. The server keeps
  `noteLeds` / `noteVelocities` for note-driven pad/step LEDs and `rgbLeds` for
  SysEx RGB LEDs; the frontend must render pads from `noteLeds` and encoders
  from `rgbLeds`.
- Step LED values from `0x10..0x1f` must not be treated as "any non-zero =
  trigger". Native Pi checks showed the engine uses dim velocities such as
  `104` for non-trigger/background step states, while active trigger/function
  steps use high velocities such as `122`, `124`, and `126`. Frontend rule:
  when the engine is emitting the step row, render only high velocity
  (`>=120`) steps as lit; if the engine emits no step-row context, fall back to
  `/api/song`.

## Pad LED meaning by mode

From the local Move manual:

- Set Overview: the 32 pads are Set slots. Colored pads are existing Sets,
  pulsing means selected, unlit means an empty slot, and white means a selected
  empty slot.
- Note Mode, Drum Rack: the left 16 pads play/sequence Drum Rack samples; the
  optional 16 Pitches layout uses the right 16 pads for pitches of the selected
  sample.
- Note Mode, melodic instruments: all 32 pads represent notes. In In-Key mode,
  root notes use the track color and other scale notes are light gray; in
  Chromatic mode notes outside the scale are unlit.
- Session Mode: pads are clip slots/scenes. Unlit pads are empty clip slots,
  track-colored pads are existing clips, white is selected, and pulsing states
  indicate playback/stop/queued states.

So "black" or unlit pads are sometimes correct engine state, not necessarily a
rendering bug. The renderer bug fixed on 2026-07-02 was the namespace collision
between note LED state and RGB ring state, not the existence of off pads.

## Pad color capture tool

Use `emulator/tools/capture-pad-led-modes.mjs` to capture pad colors directly from the
Move engine feedback stream:

```sh
node emulator/tools/capture-pad-led-modes.mjs --json > /tmp/move-pad-led-modes.json
node emulator/tools/capture-pad-led-modes.mjs --watch 30
```

Automatic capture sequence:

1. current state
2. Set Overview via `Shift + Step 1`
3. Note Mode via Track 1
4. Session toggle
5. Note toggle back

Observed on 2026-07-02 after the namespace split. Exact values vary with the
currently loaded set, selected track, selected pad, and clip state, but these
captures prove that mode changes are visible in the raw pad LED velocities:

| Capture label | Raw pad velocities observed |
| --- | --- |
| current | `18`/`23`, `122`, `123`, `126` |
| Set Overview | `0`, `8`, `11`, `14`, `15`, `21`, `24` |
| Note Mode / Track 1 | `0`, `3`, `122`, `126` |
| Session toggle | `0`, `23`, `122`, `123` |

Interpretation so far:

- `0` = off/unlit.
- `3` = dim available pad in Note Mode.
- `122`/`123` = white/light pad states observed around selected notes/clips.
- `126` = green in the documented chart.
- `8`, `11`, `14`, `15`, `21`, `23`, `24` are mode/set color indices observed
  from the engine. The emulator now keeps them as raw velocities and renders a
  distinct preview color instead of flattening them to gray.

### Shift-held step function LEDs

Native Pi capture, 2026-07-03: pressing Shift alone changes the step row from
sequencer context to function-shortcut context. The engine reports Shift as
CC `0x31 = 127` while held (`24` when released) and emits note LED velocities
on step ids `0x10..0x1f`. In the tested Note context, steps 1, 2, 3, 5, 6, 7,
and 9 lit white with velocities `122/124`; the remaining steps were zero. On
Shift release, all step note velocities returned to zero. Frontend implication:
do not render `/api/song` trigger state while Shift is held; mirror the engine
step LEDs instead.

### Palette calibration worklist (2026-07-02)

`emulator/tools/scan-led-palette.mjs` sweeps Note (all 4 tracks), Session (+ nav) and
Set Overview and reports every colour index the engine actually emits, flagging
which have a real RGB in `led-capture.mjs` vs which fall back to the invented
golden-angle HSL. Live run produced this set still needing real values:

`0x08 0x09 0x0b 0x0e 0x0f 0x12 0x15 0x17 0x18 0x46 0x6e`

`0x12`/`0x17` are the Session **clip colours**; the rest are Set Overview / other
tracks. The official chart documents only ~6 colours and states the full 128 have
"no pattern I can discern", so real RGB must come from a hardware capture (photo
per index) or the firmware palette — not invented. Drop calibrated values into
`velocityColor()` once known. Note/Session mode itself is detectable from CC
`0x32` (24 = Note, 127 = Session); the GUI uses this to render empty Session pads
as dark clip slots instead of the decorative Note-mode resting colour.

### Clip animation is in the note-on CHANNEL (2026-07-02)

Move drives pad LED animation the Push way: the note-on **channel** (low nibble
of the `9x` status byte), not the velocity, selects solid vs blink/pulse.
Verified against `spi/tx-packets.bin` by launching a clip and starting the
transport:

- **channel 0** = solid (stopped clip / static state).
- **channel 9** = pulsing "playing clip" (confirmed: a launched, playing clip
  re-lights on ch 9).
- **channels 10 / 14** also observed as animated states (queued / other launch
  states); exact rate→state mapping still to calibrate.

`led-capture.mjs` now records `noteChannels[id]`, `/api/leds` exposes it, and the
GUI (`padIsAnimated()` + `.pad.lit.pulse`) breathes any lit pad on a non-zero
channel so playing/queued clips read differently from solid ones. The engine
sends these LED events edge-triggered (once per change), so capture the raw TX at
the moment of the state change, not during steady state.

## Caveats

- Brute-force note scan above `0x63` also changes display because the active
  instrument accepts ordinary MIDI notes. Those are musical note inputs, not
  necessarily hardware controls.
- CC brute-force has context-sensitive false positives. A CC is considered
  authoritative only when it matches the local chart and/or a named runtime
  interaction in the known scan.
- Back differs between Control Live and standalone. The local chart says Back
  emits no MIDI in Control Live; standalone runtime still treats CC `0x33` as a
  candidate. It did not change display in the latest known scan, but did produce
  LED churn, so keep it marked "standalone candidate" until tested in a Back
  menu context.

## Input injection path: GUI -> engine (reverse, 2026-06-29)

How a GUI control actually reaches the standalone engine, reverse-engineered by
tracing the shim and live process state.

### File path (works)

- The surface server runs on the Raspberry (`node server.mjs`, listens on
  `0.0.0.0:9090`). `POST /api/control` encodes the USB-MIDI packet
  (`control-midi.mjs`) and appends it to `/emulator/input/midi.bin`.
- The shim reads the same `/emulator/input/midi.bin` file on the native system,
  so GUI writes are visible to the Move process immediately. The file path is
  not the bottleneck.

### Multi-process SPI architecture (important)

Three shim-loaded processes touch `/dev/ablspi0.0` (all via
`LD_PRELOAD=libablspi_shim.so`):

- `MoveLauncher` — runs the firmware-update handshake at boot, then keeps a
  persistent `MoveControlModeHandler` alive.
- `MoveControlModeHandler` — holds the SPI device; on real hardware this is the
  control bridge (reads hardware SPI, forwards control events to the engine).
- `Move` — the application engine (audio/display/sequencer). Started by
  `/emulator/start-native.sh` with `MOVE_AUDIO_STREAM=1` (only this process
  writes `spi/audio.raw`).

Gotcha: restarting only the `Move` engine by hand while the launcher-managed
`MoveControlModeHandler` keeps running produces two processes contending for the
SPI device and makes every measurement ambiguous. Always do a full clean restart
via `/emulator/start-native.sh` so there is exactly one coherent process set, all
on the current shim. Confirm the loaded shim with
`grep ablspi_shim /proc/<pid>/maps` (inode must match `stat -c %i` of the `.so`;
a `(deleted)` mapping means the process is on a stale, rebuilt-over shim).

### Shim RX-injection mechanics

The shim hooks `ioctl(SPI_CMD_TRANSFER)`. Per transfer it writes TX captures
(`tx-packets.bin`, header `reserved = getpid()` of the writer), streams audio,
answers XMOS queries (`emit_xmos_reply`), then injects queued GUI MIDI
(`inject_midi`): it reads `midi.bin` from a persistent `midi_input_offset` and
writes up to 31 USB-MIDI packets into the RX slots at `mmap + 0x800`.

### Bugs found and fixed in the shim

1. **Offset not rewound on truncate.** `midi_input_offset` only ever grew. When
   `midi.bin` was truncated/recreated (GUI "reset queue", a new session, or the
   start script clearing it), the persistent offset pointed past EOF and every
   later event was silently dropped as `midi-eof` forever. Fixed: rewind to 0
   when `offset > size`, mirroring how `server.mjs` rewinds its audio/LED tail
   offsets on shrink.
2. **XMOS responder vs input were mutually exclusive.** The handler did
   `if (!emit_xmos_reply()) inject_midi();`, so whenever the XMOS battery/devinfo
   responder fired it skipped input entirely. Fixed for coexistence:
   `emit_xmos_reply` now returns the byte count it wrote, and `inject_midi`
   appends user MIDI into the RX slots **after** the reply
   (`write_rx_midi_packets_at(..., start_slot)`), so neither starves the other.
   `inject_midi` also logs a `midi-read` line on real reads so the path is
   observable in `spi/script.log` (previously only the no-input/eof branches
   logged).

### CORRECTION: input delivery actually works (the earlier "stall" was a log cap)

An earlier draft of this doc claimed injection stopped after boot. That was
WRONG and is worth recording so nobody re-chases the ghost: `log_script_decision`
had a hard cap of `script_debug_count >= 64` and a never-reset static counter,
so it silently became a permanent no-op after the first 64 lines. Truncating
`spi/script.log` does not reset the in-memory counter, so "script.log frozen"
looked exactly like "injection stopped" when injection was in fact running.

Fixes: the 64-line cap was removed and the per-transfer `midi-eof` noise is no
longer logged, so `script.log` now records only real input reads. With honest
logging, steady-state injection is observed working:

- `reason=midi-read bytes_read=4 head=09 90 13 7f` — step button note `0x13`
  read into the RX slots well after boot.
- `head=0b b0 2b 7f` — a track-select CC `0x2b` read the same way.

End-to-end delivery is confirmed two ways: the shim logs the read, AND the
engine visibly reacts — pressing the Note/Session toggle (CC `0x32`) changes
the OLED (e.g. to a device screen titled "Dynamics"), and track-select buttons
change `isSelected` in `/api/song`. So the engine really does consume the RX
slots the shim writes. The offset-rewind and XMOS-coexistence fixes are still
correct and kept.

### Set detection fix (server)

`server.mjs readSongPatterns` grepped `About to load .*Song.abl` from BOTH
`/tmp/move-real.log` (current engine) and `/emulator/move-real.log` (a stale
prior-session log) with `tail -1`, which returns the *last file's* last match —
i.e. the stale set. The GUI therefore showed a different set than the engine had
actually loaded (engine on "Jose Castillo", GUI showing "Heavy Mellow"). Fixed
with `grep -h ... | sort | tail -1`: lines start with an ISO timestamp, so the
sort yields the chronologically newest load across both logs. `/api/song` now
matches the engine's real set.

### Remaining: step-toggle needs the right view + a drum-rack set

Clicking a step still does not visibly toggle a step LED, but the cause is now
understood and is workflow/content, not input delivery:

- The engine drives the step LED row (CC `0x10..0x1f`) but they are all `0` in
  its current view. The OLED shows a device screen ("Dynamics"), i.e. the engine
  is not in the clip/step-edit view.
- The loaded set "Jose Castillo" has NO MIDI drum-rack track (its "DRUMS" track
  is `kind=audio`); the only sequenceable MIDI track is "BASS". So there is no
  drum pattern to toggle in this set at all.

The set the engine auto-loads is governed by `currentSongIndex` in
`/data/UserData/settings/Settings.json`, indexing the sets **ordered by Song.abl
mtime, oldest first** (verified: `currentSongIndex=3` loaded the 4th-oldest set;
setting it to `4` loaded "Heavy Mellow", a real drum-rack set with 790 notes,
confirmed in the engine log).

### Button LED brightness scheme (reverse)

Engine button LEDs (the `ccs` map) are a brightness 0..127, not a binary:

- `0` = off / unavailable.
- `~24` = dim, "available but not engaged" (Shift, Mode, Loop, Copy, Mute, ...).
- `~124` = transport idle (Play and Record sit here when stopped).
- `126` = Play actively playing; `127` = Record armed/recording, and other
  buttons at full when engaged (e.g. an at-edge arrow at `127`).

So a faithful GUI lights a button only when brighter than the idle levels
(`> 124`), not on any non-zero value. The earlier `val > 0` made Play/Record
look permanently on. Fixed in `app.js`.

### Step-sequencer LEDs never light (current standalone limitation)

Despite input working and a 790-note drum set ("Heavy Mellow") loaded with its
drum track selected, the engine never lights the step row CC `0x10..0x1f` — it
stays all-zero across every reachable state: after selecting the drum track,
after pressing drum pads, after cycling Mode/Note/Capture/Loop, and during
Play (no playhead appears on the step row either). Pressing a "step" note
(`0x10..0x1f`) is audible (it triggers the sound) but does not toggle a step.

Interpretation: in this standalone engine configuration the 16 "step buttons"
do not drive a step sequencer. The real Ableton Move sequences drums on its
pad grid, not a dedicated 16-button row, so the emulator surface's separate
step row likely does not correspond to an engine step-edit feature here. Making
"press step -> it lights/toggles" work needs the Move's actual pad-based
step workflow (or the native device); it is NOT a missing input fix — input and
LED mirroring are both confirmed working.
