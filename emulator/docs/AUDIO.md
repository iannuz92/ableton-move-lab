# Live audio pipeline — engineering notes

How emulated Move audio reaches the browser, the measured health of each stage,
the defects found, and how to test them. Gated by `MOVE_AUDIO_STREAM=1`.

## The stack (4 stages)

```
Move engine ──SPI──▶ shim ──▶ audio.raw ──HTTP──▶ Node server ──fetch──▶ main thread ──postMessage──▶ AudioWorklet ──▶ DAC
              (1)        (2)              (3)                    (4)                          (5)
```

| # | Stage | Code | Clock / role |
|---|-------|------|--------------|
| 1 | Capture + pacing | `ablspi_shim.c` `write_audio_frame`, `audio_writer_main`, `pace_audio_stream` | Paces `audio.raw` to 44100 Hz (wall clock). Ring buffer (1 s) absorbs delivery bursts. |
| 2 | Source file | `emulator/spi/audio.raw` | S16LE stereo @ 44100. Wraps at `SPI_AUDIO_CAP`. |
| 3 | HTTP stream | `server.mjs` `GET /audio/stream` | Tails `audio.raw` from "now", chunked response. |
| 4 | Feed | `app.js` `pumpAudio` | fetch reader → assemble PCM → `postMessage` to worklet. |
| 5 | Playback | `pcm-worklet.js` | Ring buffer + fractional resampler bridging 44100(src) ↔ DAC clock. |

## Measured health (instrumented, not guessed)

- **Stage 1/2 — source.** Rate 44112 Hz (ratio 1.0003 to 44100). The engine emits
  512-byte blocks that are smooth *within* a block (avg sample delta ~160) but had
  a **systematic step at every block seam** (~1193) → crackle at the ~344 Hz block
  rate. Fixed by `declick_block` (see below). After: seam ~313 ≈ mid-block control ~305.
- **Stage 3 — server.** Delivery is smooth: rate ratio 1.000, max inter-chunk gap
  48 ms, zero gaps > 93 ms. Not a bottleneck.
- **Stage 4/5 — browser.** Telemetry (`/api/audiostats`): **0 underruns, 0 drops**,
  but `bufferedFrames` reached 13445 (~305 ms) with `currentRateStep` pinned at
  1.015 (+1.5%, saturated). The buffer **overfills**; the rate nudge alone drains
  it far too slowly → latency + a permanent +1.5% pitch shift. Fixed by a hard
  buffer cap.

## Root causes & fixes

1. **Source seam crackle (shim).** `declick_block` removes the inter-block step
   with a decaying correction over the first `DECLICK_FADE` frames, guarded by
   `DECLICK_MULT × local roughness` so real transients survive. Env: `MOVE_AUDIO_DECLICK`
   (default on).
2. **Worklet catastrophic re-buffer.** On any buffer dip the worklet used to reset
   and re-buffer ~93 ms (a silence gap). Now it **holds the last sample** and keeps
   playing (`lastL`/`lastR`).
3. **Worklet buffer overfill (latency + pitch).** Added a hard cap: when
   `bufferedFrames > maxBufferFrames`, drop the excess down to target once. Target
   2048 (~46 ms), cap 4096 (~93 ms). Steady drift still handled by the ±1.5% nudge.
4. **Main-thread load.** LED polling 50 ms → 120 ms to reduce contention on the
   thread that feeds the worklet.

## How to test (autonomous)

- **Generate sound without the hardware:** `POST /api/control` after selecting a
  track. Play is a toggle.
  ```
  curl -X POST localhost:9090/api/control -d '{"type":"button","id":"track1","action":"press"}'
  curl -X POST localhost:9090/api/control -d '{"type":"pad","index":26,"velocity":127,"action":"press"}'
  ```
  Pads ~14–28 produce full-scale sound on every track.
- **Source quality:** tail `emulator/spi/audio.raw` and compare jump magnitude at
  block boundaries (offset % 128 == 0) vs a mid-block control phase. Equal ⇒ no seam
  artifact. (`/private/tmp/.../seamtest.mjs` during development.)
- **Browser playback:** `GET /api/audiostats` returns the worklet's last
  `bufferedFrames` / `underrunFrames` / `droppedFrames` / `currentRateStep`.
  Healthy = bufferedFrames near target (~2048), underruns low/stable, rateStep ≈ 1.0.
- **Server delivery:** connect an HTTP client to `/audio/stream`, log inter-chunk
  gaps; healthy = no gaps > targetBuffer ms, rate ≈ 176400 B/s.
