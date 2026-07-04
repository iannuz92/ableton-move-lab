import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyLedState, processFrame, TX_MIDI_REGION } from '../lib/led-capture.mjs';

function frame(...packets) {
  const region = Buffer.alloc(TX_MIDI_REGION);
  packets.forEach((packet, index) => {
    Buffer.from(packet).copy(region, index * 4);
  });
  return region;
}

test('captures note-on step LEDs as note RGB state', () => {
  const state = emptyLedState();
  processFrame(frame([0x09, 0x90, 0x11, 0x78]), state);
  assert.deepEqual(state.notes[0x11], [255, 255, 255]);
});

test('captures note-on pad LEDs with Move color indices', () => {
  const state = emptyLedState();
  processFrame(frame([0x09, 0x90, 0x44, 0x7e]), state);
  assert.deepEqual(state.notes[0x44], [0, 255, 0]);
  assert.deepEqual(state.noteLeds[0x44], [0, 255, 0]);
  assert.equal(state.noteVelocities[0x44], 0x7e);
});

test('renders undocumented non-dim velocity indices as distinct preview colors', () => {
  const state = emptyLedState();
  processFrame(frame(
    [0x09, 0x90, 0x44, 0x03],
    [0x09, 0x90, 0x45, 0x08],
    [0x09, 0x90, 0x46, 0x0b],
  ), state);

  assert.deepEqual(state.noteLeds[0x44], [30, 30, 30]);
  assert.notDeepEqual(state.noteLeds[0x45], state.noteLeds[0x46]);
  assert.notEqual(new Set(state.noteLeds[0x45]).size, 1);
  assert.notEqual(new Set(state.noteLeds[0x46]).size, 1);
});

test('records the note-on channel as the clip animation selector', () => {
  const state = emptyLedState();
  // Solid clip on channel 0.
  processFrame(frame([0x09, 0x90, 0x54, 0x17]), state);
  assert.equal(state.noteChannels[0x54], 0);

  // Playing clip re-lit on channel 9 (verified on the live engine).
  processFrame(frame([0x09, 0x99, 0x54, 0x7a]), state);
  assert.equal(state.noteChannels[0x54], 9);

  // Note-off clears the animation channel back to 0.
  processFrame(frame([0x08, 0x80, 0x54, 0x00]), state);
  assert.equal(state.noteChannels[0x54], 0);

  // Zero-velocity note-on is an off event, so channel resets even on 0x9x.
  processFrame(frame([0x09, 0x9a, 0x54, 0x00]), state);
  assert.equal(state.noteChannels[0x54], 0);
});

test('turns note LEDs off on note-off or zero-velocity note-on', () => {
  const state = emptyLedState();
  processFrame(frame([0x09, 0x90, 0x10, 0x78]), state);
  processFrame(frame([0x08, 0x80, 0x10, 0x00]), state);
  assert.deepEqual(state.notes[0x10], [0, 0, 0]);
  assert.deepEqual(state.noteLeds[0x10], [0, 0, 0]);
  assert.equal(state.noteVelocities[0x10], 0);

  processFrame(frame([0x09, 0x90, 0x10, 0x78]), state);
  processFrame(frame([0x09, 0x90, 0x10, 0x00]), state);
  assert.deepEqual(state.notes[0x10], [0, 0, 0]);
  assert.deepEqual(state.noteLeds[0x10], [0, 0, 0]);
  assert.equal(state.noteVelocities[0x10], 0);
});

test('ignores reserved CIN nibbles that look like CC data', () => {
  const state = emptyLedState();
  processFrame(frame([0x3b, 0xb0, 0x10, 0x7f]), state);
  assert.deepEqual(state.ccs, {});
});

test('keeps note LEDs separate from RGB SysEx LEDs with the same id', () => {
  const state = emptyLedState();
  processFrame(frame([0x09, 0x90, 0x47, 0x7e]), state);

  const sysex = [
    [0x04, 0xf0, 0x00, 0x21],
    [0x04, 0x1d, 0x01, 0x01],
    [0x04, 0x3b, 0x10, 0x47],
    [0x04, 0x7f, 0x00, 0x00],
    [0x04, 0x00, 0x00, 0x00],
    [0x05, 0xf7, 0x00, 0x00],
  ];
  processFrame(frame(...sysex), state);

  assert.deepEqual(state.noteLeds[0x47], [0, 255, 0]);
  assert.deepEqual(state.rgbLeds[0x47], [254, 0, 0]);
  assert.deepEqual(state.notes[0x47], [254, 0, 0]);
});
