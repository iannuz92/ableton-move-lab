import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alignPcmByteLength,
  appendBytes,
  createRealtimePacer,
  takeChunk,
} from '../lib/audio-stream.mjs';

test('alignPcmByteLength keeps only complete stereo int16 frames', () => {
  assert.equal(alignPcmByteLength(0), 0);
  assert.equal(alignPcmByteLength(3), 0);
  assert.equal(alignPcmByteLength(4), 4);
  assert.equal(alignPcmByteLength(8195), 8192);
});

test('appendBytes preserves byte order without mutating inputs', () => {
  const left = Buffer.from([1, 2, 3, 4]);
  const right = Buffer.from([5, 6, 7, 8]);
  assert.deepEqual([...appendBytes(left, right)], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...left], [1, 2, 3, 4]);
  assert.deepEqual([...right], [5, 6, 7, 8]);
});

test('takeChunk waits for the minimum chunk unless forced by maximum', () => {
  const small = Buffer.alloc(2048);
  assert.equal(takeChunk(small, 4096, 16384).chunk, null);

  const ready = Buffer.alloc(4096);
  const result = takeChunk(ready, 4096, 16384);
  assert.equal(result.chunk.length, 4096);
  assert.equal(result.remaining.length, 0);
});

test('takeChunk caps large buffers and keeps the remainder', () => {
  const source = Buffer.alloc(20000);
  const result = takeChunk(source, 4096, 16384);
  assert.equal(result.chunk.length, 16384);
  assert.equal(result.remaining.length, 3616);
});

test('takeChunk never splits a PCM frame', () => {
  const source = Buffer.alloc(8195);
  const result = takeChunk(source, 0, 8195);
  assert.equal(result.chunk.length, 8192);
  assert.equal(result.remaining.length, 3);
});

test('createRealtimePacer releases bytes according to elapsed wall time', () => {
  let now = 1000;
  const pacer = createRealtimePacer({
    bytesPerSecond: 176400,
    initialCreditBytes: 4096,
    now: () => now,
  });

  assert.equal(pacer.availableBytes(), 4096);
  pacer.consume(4096);
  assert.equal(pacer.availableBytes(), 0);

  now += 100;
  assert.equal(pacer.availableBytes(), 17640);
  pacer.consume(10000);
  assert.equal(pacer.availableBytes(), 7640);
});

test('createRealtimePacer keeps availability aligned to PCM frame boundaries', () => {
  let now = 0;
  const pacer = createRealtimePacer({
    bytesPerSecond: 101,
    now: () => now,
  });

  now = 100;
  assert.equal(pacer.availableBytes(), 8);
});
