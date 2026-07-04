/*
 * Move control -> USB-MIDI mapping.
 *
 * Authoritative note/CC numbers from the reverse-engineered "Ableton Move MIDI
 * Over USB-C" chart by Jens Alfke (v3, Jan 2025). All values channel 1. The
 * standalone XMOS->engine protocol uses the same assignments as Control Live
 * mode (verified: wheel press = CC3, wheel rotate = CC0x0E, encoders =
 * CC0x47..0x4E).
 *
 * USB-MIDI packet = [CIN, status, data1, data2]. CIN: 0x09 note-on,
 * 0x08 note-off, 0x0A poly aftertouch, 0x0B control change (cable 0).
 */

// Function buttons -> CC number (decimal). Pressed = 0x7F, released = 0x00.
const buttonCC = {
  shift: 0x31,     // 49
  note: 0x32,      // 50  Note/Session toggle ("Mode")
  session: 0x32,   // 50  same physical toggle
  capture: 0x34,   // 52
  sample: 0x76,    // 118
  loop: 0x3a,      // 58
  mute: 0x58,      // 88
  delete: 0x77,    // 119
  copy: 0x3c,      // 60
  undo: 0x38,      // 56
  record: 0x56,    // 86
  play: 0x55,      // 85
  wheelPress: 0x03, // 3   big wheel press/click, distinct from rotation
  left: 0x3e,      // 62  <
  right: 0x3f,     // 63  >
  minus: 0x36,     // 54  -
  plus: 0x37,      // 55  +
  track1: 0x2b,    // 43  (top)
  track2: 0x2a,    // 42
  track3: 0x29,    // 41
  track4: 0x28,    // 40  (bottom)
  back: 0x33,      // 51  Back (found by capture: CC 0x33 exits menus; the
                   // Control-Live chart omits it because there it exits the mode)
};

// Rotate CCs for the touch encoders and the two special wheels.
const ENCODER_CC_BASE = 0x47; // encoders 0..7 -> 0x47..0x4E (71..78)
const VOLUME_CC = 0x4f;       // 79  volume encoder (top-right)
const WHEEL_CC = 0x0e;        // 14  big wheel rotation (menu navigation)
const ENCODER_TOUCH_NOTE_BASE = 0x00; // encoders 0..7 touch -> notes 0x00..0x07
const VOLUME_TOUCH_NOTE = 0x08;
const WHEEL_TOUCH_NOTE = 0x09;

// Pads occupy notes 0x44..0x63 laid out bottom row .. top row on the device.
// The GUI numbers pads 0..31 row-major from the TOP-LEFT, so map row 0 (top)
// to 0x5C and descend by a row (8 notes) for each row going down.
function padNote(index) {
  const row = Math.floor(index / 8); // 0 = top .. 3 = bottom
  const col = index % 8;
  return 0x5c - row * 8 + col;
}

// Relative encoder value: clockwise = 0x01 per step, counter-clockwise = 0x7F.
function relative(delta) {
  return Number(delta || 1) > 0 ? 0x01 : 0x7f;
}

export function usbMidiPacket(event) {
  if (event.type === 'pad') {
    const note = padNote(Number(event.index || 0));
    const velocity = Math.max(1, Math.min(127, Number(event.velocity || 100)));
    return event.action === 'release'
      ? Buffer.from([0x08, 0x80, note, 0])
      : Buffer.from([0x09, 0x90, note, velocity]);
  }

  if (event.type === 'aftertouch') {
    const note = padNote(Number(event.index || 0));
    return Buffer.from([0x0a, 0xa0, note, Math.max(0, Math.min(127, Number(event.value || 0)))]);
  }

  if (event.type === 'step') {
    // Step buttons are note-based (0x10..0x1F), like pads.
    const note = 0x10 + (Number(event.index || 0) % 16);
    return event.action === 'release'
      ? Buffer.from([0x08, 0x80, note, 0])
      : Buffer.from([0x09, 0x90, note, 0x7f]);
  }

  if (event.type === 'touch') {
    const note = event.id === 'wheel'
      ? WHEEL_TOUCH_NOTE
      : Number(event.index || 0) >= 8
        ? VOLUME_TOUCH_NOTE
        : ENCODER_TOUCH_NOTE_BASE + Math.max(0, Math.min(7, Number(event.index || 0)));
    return event.action === 'release'
      ? Buffer.from([0x08, 0x80, note, 0])
      : Buffer.from([0x09, 0x90, note, 0x7f]);
  }

  if (event.type === 'encoder') {
    // Encoders 0..7 -> 0x47..0x4E; the volume encoder is index 8 -> 0x4F.
    const index = Math.max(0, Math.min(8, Number(event.index || 0)));
    return Buffer.from([0x0b, 0xb0, ENCODER_CC_BASE + index, relative(event.delta)]);
  }

  if (event.type === 'wheel') {
    // Big wheel rotation: navigates menus / the Set Overview.
    return Buffer.from([0x0b, 0xb0, WHEEL_CC, relative(event.delta)]);
  }

  if (event.type === 'volume') {
    return Buffer.from([0x0b, 0xb0, VOLUME_CC, relative(event.delta)]);
  }

  // Function button (CC 0x7F press / 0x00 release).
  const cc = buttonCC[event.id];
  if (cc === undefined) return Buffer.alloc(0); // unknown control (e.g. Back)
  return Buffer.from([0x0b, 0xb0, cc, event.action === 'release' ? 0 : 0x7f]);
}
