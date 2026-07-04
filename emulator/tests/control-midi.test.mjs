import assert from 'node:assert/strict';
import test from 'node:test';

import { usbMidiPacket } from '../lib/control-midi.mjs';

// Authoritative numbers from the "Ableton Move MIDI Over USB-C" chart (Jens
// Alfke, v3). All on channel 1; buttons 0x7F press / 0x00 release.

test('wheel press = CC 0x03 and is separate from rotation', () => {
  assert.deepEqual(
    usbMidiPacket({ type: 'button', id: 'wheelPress', action: 'press' }),
    Buffer.from([0x0b, 0xb0, 0x03, 0x7f]),
  );
  assert.deepEqual(
    usbMidiPacket({ type: 'button', id: 'wheelPress', action: 'release' }),
    Buffer.from([0x0b, 0xb0, 0x03, 0x00]),
  );
  assert.equal(usbMidiPacket({ type: 'button', id: 'wheel', action: 'press' }).length, 0);
});

test('wheel rotate = CC 0x0E, relative (CW 0x01 / CCW 0x7F)', () => {
  assert.deepEqual(usbMidiPacket({ type: 'wheel', delta: 1 }), Buffer.from([0x0b, 0xb0, 0x0e, 0x01]));
  assert.deepEqual(usbMidiPacket({ type: 'wheel', delta: -1 }), Buffer.from([0x0b, 0xb0, 0x0e, 0x7f]));
});

test('encoders rotate = CC 0x47..0x4E, volume (index 8) = CC 0x4F', () => {
  assert.deepEqual(usbMidiPacket({ type: 'encoder', index: 0, delta: 1 }), Buffer.from([0x0b, 0xb0, 0x47, 0x01]));
  assert.deepEqual(usbMidiPacket({ type: 'encoder', index: 7, delta: -1 }), Buffer.from([0x0b, 0xb0, 0x4e, 0x7f]));
  assert.deepEqual(usbMidiPacket({ type: 'encoder', index: 8, delta: 1 }), Buffer.from([0x0b, 0xb0, 0x4f, 0x01]));
});

test('encoder, volume, and wheel touch use note 0x00..0x09', () => {
  assert.deepEqual(usbMidiPacket({ type: 'touch', index: 0, action: 'press' }), Buffer.from([0x09, 0x90, 0x00, 0x7f]));
  assert.deepEqual(usbMidiPacket({ type: 'touch', index: 7, action: 'release' }), Buffer.from([0x08, 0x80, 0x07, 0x00]));
  assert.deepEqual(usbMidiPacket({ type: 'touch', index: 8, action: 'press' }), Buffer.from([0x09, 0x90, 0x08, 0x7f]));
  assert.deepEqual(usbMidiPacket({ type: 'touch', id: 'wheel', action: 'press' }), Buffer.from([0x09, 0x90, 0x09, 0x7f]));
});

test('new buttons map to the chart CCs', () => {
  assert.deepEqual(usbMidiPacket({ type: 'button', id: 'copy', action: 'press' }), Buffer.from([0x0b, 0xb0, 0x3c, 0x7f]));
  assert.deepEqual(usbMidiPacket({ type: 'button', id: 'sample', action: 'press' }), Buffer.from([0x0b, 0xb0, 0x76, 0x7f]));
  assert.deepEqual(usbMidiPacket({ type: 'button', id: 'left', action: 'press' }), Buffer.from([0x0b, 0xb0, 0x3e, 0x7f]));
  assert.deepEqual(usbMidiPacket({ type: 'button', id: 'right', action: 'press' }), Buffer.from([0x0b, 0xb0, 0x3f, 0x7f]));
  assert.deepEqual(usbMidiPacket({ type: 'button', id: 'minus', action: 'press' }), Buffer.from([0x0b, 0xb0, 0x36, 0x7f]));
  assert.deepEqual(usbMidiPacket({ type: 'button', id: 'plus', action: 'press' }), Buffer.from([0x0b, 0xb0, 0x37, 0x7f]));
});

test('pads = note 0x44..0x63, top row first in the GUI', () => {
  assert.deepEqual(usbMidiPacket({ type: 'pad', index: 0, action: 'press', velocity: 100 }), Buffer.from([0x09, 0x90, 0x5c, 100]));
  assert.deepEqual(usbMidiPacket({ type: 'pad', index: 24, action: 'press', velocity: 100 }), Buffer.from([0x09, 0x90, 0x44, 100]));
  assert.deepEqual(usbMidiPacket({ type: 'pad', index: 0, action: 'release', velocity: 0 }), Buffer.from([0x08, 0x80, 0x5c, 0]));
});

test('step buttons = note 0x10..0x1F', () => {
  assert.deepEqual(usbMidiPacket({ type: 'step', index: 0, action: 'press' }), Buffer.from([0x09, 0x90, 0x10, 0x7f]));
  assert.deepEqual(usbMidiPacket({ type: 'step', index: 15, action: 'release' }), Buffer.from([0x08, 0x80, 0x1f, 0]));
});

test('function buttons use the chart CCs', () => {
  assert.deepEqual(usbMidiPacket({ type: 'button', id: 'play', action: 'press' }), Buffer.from([0x0b, 0xb0, 0x55, 0x7f]));
  assert.deepEqual(usbMidiPacket({ type: 'button', id: 'shift', action: 'press' }), Buffer.from([0x0b, 0xb0, 0x31, 0x7f]));
  assert.deepEqual(usbMidiPacket({ type: 'button', id: 'track1', action: 'press' }), Buffer.from([0x0b, 0xb0, 0x2b, 0x7f]));
});

test('Back = CC 0x33', () => {
  assert.deepEqual(usbMidiPacket({ type: 'button', id: 'back', action: 'press' }), Buffer.from([0x0b, 0xb0, 0x33, 0x7f]));
});

test('truly unknown control emits no bytes', () => {
  assert.equal(usbMidiPacket({ type: 'button', id: 'nope', action: 'press' }).length, 0);
});
