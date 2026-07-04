/*
 * Parse the engine's MIDI-OUT (LED feedback) from the SPI TX frames.
 *
 * The engine drives the RGB LEDs by writing USB-MIDI into the TX MIDI region
 * (mmap+0x000, first 0x50 bytes of each captured frame). Two kinds of events:
 *
 *  - Pad / Step / Track RGB LEDs via SysEx:
 *      F0 00 21 1D 01 01 3B 10 <id> <Rlo Rhi> <Glo Ghi> <Blo Bhi> F7
 *    <id> is the control's note/CC number (steps 0x10-0x1F, pads 0x44-0x63,
 *    track buttons 0x28-0x2B). Each channel is 7-bit lo + 7-bit hi.
 *
 *  - Pad / Step LEDs via Note On/Off:
 *      90 <id> <velocity> lights a pad/step; velocity is Move's color index.
 *      80 <id> 00 or 90 <id> 00 turns it off.
 *    The note-on CHANNEL (low nibble of the status byte) selects the LED
 *    animation, the same way Push does: channel 0 = solid, non-zero channels =
 *    blink/pulse. Verified on the live engine: launching a clip and starting the
 *    transport re-lights its pad on channel 9 (a pulsing "playing clip" state),
 *    while stopped clips stay on channel 0. We record the channel so the GUI can
 *    animate playing/queued clips instead of showing every state as solid.
 *
 *  - Plain button LEDs via CC:  B0 <cc> <val>  (val 0x7F on / 0x00 off)
 *
 * Events are transient (sent once when an LED changes), so the caller keeps a
 * cumulative state and feeds every new frame through processFrame().
 */

export const TX_MIDI_REGION = 0x50; // bytes of MIDI-out at the start of a frame

function chan(lo, hi) {
  const v = (lo & 0x7f) | ((hi & 0x7f) << 7);
  return Math.min(255, v * 2); // 7-bit-ish -> 8-bit for display
}

function hslToRgb(hue, saturation, lightness) {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r1, g1, b1] = [0, 0, 0];
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = lightness - c / 2;
  return [r1, g1, b1].map((channel) => Math.round((channel + m) * 255));
}

function indexedVelocityColor(value) {
  // The public USB-MIDI chart documents a few color indices and states that
  // the rest of 1..127 are distinct. Keep undocumented non-dim indices visually
  // distinct while preserving the raw value in state.noteVelocities for exact
  // calibration against real hardware captures.
  const hue = (value * 137.508) % 360;
  return hslToRgb(hue, 0.76, 0.52);
}

function velocityColor(velocity) {
  if (!velocity) return [0, 0, 0];
  // Known Move USB-MIDI light color indices from the local chart.
  switch (velocity & 0x7f) {
    case 0x7f: return [255, 0, 0];       // red
    case 0x4f: return [255, 220, 0];     // yellow
    case 0x7e: return [0, 255, 0];       // green
    case 0x5f: return [0, 255, 255];     // cyan
    case 0x7d: return [0, 80, 255];      // blue
    case 0x6f: return [180, 0, 255];     // purple
    case 0x78:
    case 0x7a:
    case 0x7b:
    case 0x7c:
      return [255, 255, 255];            // white variants observed at runtime
    default: {
      const value = velocity & 0x7f;
      if (value <= 3) return [30, 30, 30];
      return indexedVelocityColor(value);
    }
  }
}

// Update `state` ({ notes: {id:[r,g,b]}, ccs: {cc:val} }) from one frame's
// MIDI-out region (Buffer/Uint8Array, at least TX_MIDI_REGION bytes).
export function processFrame(region, state) {
  state.notes ||= {};
  state.noteLeds ||= {};
  state.rgbLeds ||= {};
  state.noteVelocities ||= {};
  state.noteChannels ||= {};
  state.ccs ||= {};
  const data = [];
  for (let j = 0; j + 4 <= TX_MIDI_REGION; j += 4) {
    const rawCin = region[j];
    const cin = rawCin & 0x0f;
    // Validate cable 0 + real USB-MIDI CINs. Raw bytes that happen to have 0x0b
    // in the low nibble (e.g. 0x3b from SysEx data) would otherwise be
    // misidentified as CC messages.
    if ((rawCin & 0xf0) !== 0 || cin < 0x04 || cin > 0x0e) continue;
    const b1 = region[j + 1], b2 = region[j + 2], b3 = region[j + 3];
    if (cin === 0x0b && (b1 & 0xf0) === 0xb0) {
      state.ccs[b2] = b3; // button LED on/off (color)
    } else if (cin === 0x09 && (b1 & 0xf0) === 0x90) {
      const rgb = velocityColor(b3);
      state.noteVelocities[b2] = b3;
      state.noteLeds[b2] = rgb;
      state.notes[b2] = rgb;
      // Channel selects the animation (0 = solid, non-zero = blink/pulse).
      // Velocity 0 is an off event even on the note-on status.
      state.noteChannels[b2] = b3 ? (b1 & 0x0f) : 0;
    } else if (cin === 0x08 && (b1 & 0xf0) === 0x80) {
      state.noteVelocities[b2] = 0;
      state.noteLeds[b2] = [0, 0, 0];
      state.notes[b2] = [0, 0, 0];
      state.noteChannels[b2] = 0;
    } else if (cin === 0x04 || cin === 0x07) {
      data.push(b1, b2, b3);
    } else if (cin === 0x06) {
      data.push(b1, b2);
    } else if (cin === 0x05) {
      data.push(b1);
    }
  }
  // Split reassembled bytes into SysEx messages and decode LED sets.
  let i = 0;
  while (i < data.length) {
    if (data[i] !== 0xf0) { i += 1; continue; }
    let k = i + 1;
    while (k < data.length && data[k] !== 0xf7) k += 1;
    const sx = data.slice(i, k);
    if (
      sx.length >= 15 &&
      sx[1] === 0x00 && sx[2] === 0x21 && sx[3] === 0x1d &&
      sx[6] === 0x3b && sx[7] === 0x10
    ) {
      const id = sx[8];
      const rgb = [chan(sx[9], sx[10]), chan(sx[11], sx[12]), chan(sx[13], sx[14])];
      state.rgbLeds[id] = rgb;
      state.notes[id] = rgb;
    }
    i = k + 1;
  }
  return state;
}

export function emptyLedState() {
  return { notes: {}, noteLeds: {}, rgbLeds: {}, noteVelocities: {}, noteChannels: {}, ccs: {} };
}
