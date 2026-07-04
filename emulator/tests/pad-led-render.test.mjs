import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dimTrackRgb,
  hexToRgb,
  padIsAnimated,
  padLedRgb,
  selectedTrackRgb,
  trackLedIdForIndex,
} from '../public/pad-led-render.mjs';

test('maps selected track indexes to Move track RGB ids', () => {
  assert.equal(trackLedIdForIndex(0), 0x2b);
  assert.equal(trackLedIdForIndex(1), 0x2a);
  assert.equal(trackLedIdForIndex(2), 0x29);
  assert.equal(trackLedIdForIndex(3), 0x28);
});

test('uses the selected track RGB for dim pad velocity', () => {
  const leds = {
    noteVelocities: { 0x44: 3 },
    noteLeds: { 0x44: [30, 30, 30] },
    rgbLeds: { 0x2b: [255, 118, 0] },
  };

  assert.deepEqual(padLedRgb(leds, 0x44, { trackIndex: 0 }), [209, 97, 48]);
});

test('keeps velocity zero pads off even when overlapping RGB exists', () => {
  const leds = {
    noteVelocities: { 0x48: 0 },
    noteLeds: { 0x48: [0, 0, 0] },
    rgbLeds: { 0x48: [255, 255, 255] },
  };

  assert.equal(padLedRgb(leds, 0x48, { trackIndex: 0 }), null);
});

test('uses regular note LED colors for non-dim pad velocities', () => {
  const leds = {
    noteVelocities: { 0x46: 122 },
    noteLeds: { 0x46: [255, 255, 255] },
    rgbLeds: { 0x2b: [255, 118, 0] },
  };

  assert.deepEqual(padLedRgb(leds, 0x46, { trackIndex: 0 }), [255, 255, 255]);
});

test('flags a lit pad on a non-zero note channel as animated (playing/queued clip)', () => {
  const leds = { noteChannels: { 0x54: 9, 0x4c: 0 } };
  assert.equal(padIsAnimated(leds, 0x54, true), true);   // channel 9 = pulsing
  assert.equal(padIsAnimated(leds, 0x4c, true), false);  // channel 0 = solid
  assert.equal(padIsAnimated(leds, 0x54, false), false); // not lit -> never pulses
  assert.equal(padIsAnimated({}, 0x54, true), false);    // no channel data -> solid
});

test('falls back to configured track color when engine track RGB is unavailable', () => {
  assert.deepEqual(hexToRgb('#ff7600'), [255, 118, 0]);
  assert.deepEqual(selectedTrackRgb({ rgbLeds: {} }, 0, [255, 118, 0]), [255, 118, 0]);
  assert.deepEqual(dimTrackRgb([255, 118, 0]), [209, 97, 48]);
});
