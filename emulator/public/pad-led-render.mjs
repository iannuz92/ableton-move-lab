export function trackLedIdForIndex(trackIndex) {
  return 0x2b - Math.max(0, Math.min(3, Number(trackIndex) || 0));
}

export function hexToRgb(hex) {
  const value = String(hex || '').replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

export function dimTrackRgb(rgb) {
  if (!Array.isArray(rgb)) return [30, 30, 30];
  return rgb.map((channel) => Math.max(48, Math.round(channel * 0.82)));
}

export function selectedTrackRgb(leds, trackIndex, fallbackRgb = null) {
  const id = trackLedIdForIndex(trackIndex);
  return (leds.rgbLeds || {})[id] || fallbackRgb;
}

// The engine encodes clip animation in the note-on channel: 0 = solid,
// non-zero = blink/pulse (verified: a playing clip re-lights on channel 9, a
// freshly launched/queued one on 14). A pad should pulse only when it is both
// lit and carried on a non-zero channel.
export function padIsAnimated(leds, id, isLit) {
  if (!isLit) return false;
  const channel = Number((leds.noteChannels || {})[id]);
  return Number.isFinite(channel) && channel > 0;
}

export function padLedRgb(leds, id, { trackIndex = 0, fallbackTrackRgb = null } = {}) {
  const velocities = leds.noteVelocities || {};
  const velocity = velocities[id];
  if (velocity !== undefined) {
    if (Number(velocity) === 0) return null;
    if (Number(velocity) <= 3) {
      return dimTrackRgb(selectedTrackRgb(leds, trackIndex, fallbackTrackRgb));
    }
    return (leds.noteLeds || {})[id] || null;
  }
  // Encoder RGB rings share ids 0x47..0x4f with pad notes, so never use an
  // RGB-only event in that overlapping range as pad state.
  if (id >= 0x47 && id <= 0x4f) return null;
  return leds.rgbLeds ? leds.rgbLeds[id] : (leds.notes || {})[id];
}
