import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISPLAY_PACKET_SIZE,
  SPI_RECORD_HEADER_SIZE,
  parseDisplayCapture,
} from '../lib/display-capture.mjs';

function captureRecord(sequence, request, value, source = 0) {
  const packet = Buffer.alloc(DISPLAY_PACKET_SIZE);
  packet.writeUInt32LE(request, 0x50);

  const frameOffset = (request - 1) * 0xac;
  const chunkLength = Math.min(0xac, 0x400 - frameOffset);
  packet.fill(value, 0x54, 0x54 + chunkLength);

  const header = Buffer.alloc(SPI_RECORD_HEADER_SIZE);
  header.writeBigUInt64LE(BigInt(sequence), 0);
  header.writeUInt32LE(packet.length, 16);
  header.writeUInt32LE(source, 20);
  return Buffer.concat([header, packet]);
}

test('keeps the last complete display frame when the next cycle is partial', () => {
  const records = [];

  for (let request = 1; request <= 6; request += 1) {
    records.push(captureRecord(request, request, 0x11));
  }
  for (let request = 1; request <= 3; request += 1) {
    records.push(captureRecord(6 + request, request, 0x22));
  }

  const result = parseDisplayCapture(Buffer.concat(records));
  const framebuffer = Buffer.from(result.framebuffer, 'base64');

  assert.equal(result.completeFrames, 1);
  assert.equal(result.lastSequence, 6);
  assert.equal(result.lastRequest, 6);
  assert.deepEqual(framebuffer, Buffer.alloc(0x400, 0x11));
});

test('reconstructs the entire 128x64 framebuffer including its final bytes', () => {
  const records = [];

  for (let request = 1; request <= 6; request += 1) {
    records.push(captureRecord(request, request, request));
  }

  const result = parseDisplayCapture(Buffer.concat(records));
  const framebuffer = Buffer.from(result.framebuffer, 'base64');

  assert.equal(framebuffer.length, 128 * 64 / 8);
  assert.equal(framebuffer[0], 1);
  assert.equal(framebuffer[0xab], 1);
  assert.equal(framebuffer[0xac], 2);
  assert.equal(framebuffer[0x35b], 5);
  assert.equal(framebuffer[0x35c], 6);
  assert.equal(framebuffer[0x3ff], 6);
});

test('reconstructs independent frame cycles from interleaved SPI processes', () => {
  const records = [];

  for (let request = 1; request <= 6; request += 1) {
    records.push(captureRecord(request * 2 - 1, request, 0x11, 101));
    records.push(captureRecord(request * 2, request, 0x22, 202));
  }

  const result = parseDisplayCapture(Buffer.concat(records));
  const framebuffer = Buffer.from(result.framebuffer, 'base64');

  assert.equal(result.completeFrames, 2);
  assert.equal(result.lastSequence, 12);
  assert.equal(result.source, 202);
  assert.deepEqual(framebuffer, Buffer.alloc(0x400, 0x22));
});

test('does not let a newer blank control-mode frame hide the engine framebuffer', () => {
  const records = [];

  for (let request = 1; request <= 6; request += 1) {
    records.push(captureRecord(request, request, 0x33, 76));
  }
  for (let request = 1; request <= 6; request += 1) {
    records.push(captureRecord(6 + request, request, 0x00, 67));
  }

  const result = parseDisplayCapture(Buffer.concat(records));
  const framebuffer = Buffer.from(result.framebuffer, 'base64');

  assert.equal(result.completeFrames, 2);
  assert.equal(result.lastSequence, 6);
  assert.equal(result.source, 76);
  assert.deepEqual(framebuffer, Buffer.alloc(0x400, 0x33));
});
