import assert from 'node:assert/strict';
import test from 'node:test';

import {
  padIdForIndex,
  summarizePadLeds,
  summarizeVelocities,
} from '../tools/capture-pad-led-modes.mjs';

test('padIdForIndex maps GUI top-left order to Move pad note ids', () => {
  assert.equal(padIdForIndex(0), 0x5c);
  assert.equal(padIdForIndex(7), 0x63);
  assert.equal(padIdForIndex(24), 0x44);
  assert.equal(padIdForIndex(31), 0x4b);
});

test('summarizeVelocities groups pads by raw Move LED velocity', () => {
  const summary = summarizeVelocities([
    { index: 0, velocity: 0 },
    { index: 1, velocity: 3 },
    { index: 2, velocity: 3 },
    { index: 3, velocity: 122 },
    { index: 4, velocity: null },
  ]);

  assert.deepEqual(summary, [
    { velocity: 0, count: 1, pads: [0] },
    { velocity: 3, count: 2, pads: [1, 2] },
    { velocity: 122, count: 1, pads: [3] },
    { velocity: null, count: 1, pads: [4] },
  ]);
});

test('summarizePadLeds keeps note and RGB LED namespaces visible', () => {
  const summary = summarizePadLeds({
    noteVelocities: { 0x47: 3 },
    noteLeds: { 0x47: [30, 30, 30] },
    rgbLeds: { 0x47: [255, 255, 255] },
  });

  const pad27 = summary.pads.find((pad) => pad.index === 27);
  assert.deepEqual(pad27, {
    index: 27,
    id: 0x47,
    idHex: '0x47',
    velocity: 3,
    noteRgb: [30, 30, 30],
    rgbRgb: [255, 255, 255],
  });
});
