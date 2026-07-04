import assert from 'node:assert/strict';
import test from 'node:test';

import { createAudioPump } from '../public/audio-pump.mjs';

function approxEqual(actual, expected, third, fourth) {
  const eps = typeof third === 'number' ? third : 1e-9;
  const msg = typeof third === 'string' ? third : fourth ?? `approxEqual: ${actual} ~= ${expected}`;
  assert.ok(Math.abs(actual - expected) < eps, msg);
}

// Mock AudioContext: records start() calls as (startedAt, buf).
function makeMockCtx(initialTime = 0) {
  const scheduled = [];
  return {
    currentTime: initialTime,
    destination: {},
    createBufferSource() {
      const src = {
        buffer: null,
        startedAt: null,
        connect() {},
        start(t) { this.startedAt = t; scheduled.push({ startedAt: t, buffer: this.buffer }); },
      };
      return src;
    },
    createBuffer() { return { duration: 0, getChannelData: () => new Float32Array(0) }; },
    _scheduled: scheduled,
    advance(dt) { this.currentTime += dt; },
  };
}

function makeBuffer(duration) {
  return { duration, getChannelData: () => new Float32Array(0) };
}

test('prime: first schedule anchored to now + targetLead', () => {
  const ctx = makeMockCtx(0);
  const pump = createAudioPump(ctx, { targetLead: 0.04, minLead: 0.005, maxLead: 0.20 });
  pump.start();
  pump.push(makeBuffer(0.02));
  pump.processTicks();
  assert.equal(ctx._scheduled.length, 1);
  approxEqual(ctx._scheduled[0].startedAt, 0.04);
  approxEqual(pump.nextStartTime, 0.06);  // startTime + buf.duration
  pump.stop();
});

test('contiguous scheduling: consecutive buffers without gaps or overlap', () => {
  const ctx = makeMockCtx(0);
  const pump = createAudioPump(ctx, { targetLead: 0.04, minLead: 0.005, maxLead: 0.20 });
  pump.start();
  for (let i = 0; i < 5; i += 1) pump.push(makeBuffer(0.01));
  pump.processTicks();
  assert.equal(ctx._scheduled.length, 5);
  approxEqual(ctx._scheduled[0].startedAt, 0.04);
  for (let i = 1; i < 5; i += 1) {
    approxEqual(ctx._scheduled[i].startedAt, ctx._scheduled[i - 1].startedAt + 0.01);
  }
  approxEqual(pump.nextStartTime, 0.04 + 5 * 0.01);
  pump.stop();
});

test('queue cap: when queuedDuration exceeds maxLead, drops from the front', () => {
  const ctx = makeMockCtx(0);
  const pump = createAudioPump(ctx, { targetLead: 0.04, minLead: 0.005, maxLead: 0.20 });
  pump.start();
  // Ten 0.05s buffers = 0.50s total. Cap drops to qd <= 0.20 (6 dropped, 4 left).
  // Schedule: prime 0.04, then 0.09, 0.14, 0.19 -> 4 scheduled (lead <= 0.20).
  for (let i = 0; i < 10; i += 1) {
    const b = makeBuffer(0.05);
    b.id = i;
    pump.push(b);
  }
  pump.processTicks();
  assert.equal(ctx._scheduled.length, 4);
  assert.equal(pump.queueLength, 0);
  // Survivors are the last 4 queue items (id 6-9), after the cap.
  for (let i = 0; i < 4; i += 1) {
    assert.equal(ctx._scheduled[i].buffer.id, 6 + i);
  }
  pump.stop();
});

test('queue cap preserves timeline: no overlap, contiguous time', () => {
  const ctx = makeMockCtx(0);
  const pump = createAudioPump(ctx, { targetLead: 0.04, minLead: 0.005, maxLead: 0.20 });
  pump.start();
  for (let i = 0; i < 10; i += 1) {
    const b = makeBuffer(0.05);
    b.id = i;
    pump.push(b);
  }
  pump.processTicks();
  for (let i = 1; i < ctx._scheduled.length; i += 1) {
    const prev = ctx._scheduled[i - 1];
    const cur = ctx._scheduled[i];
    approxEqual(cur.startedAt, prev.startedAt + prev.buffer.duration,
      `step ${i}: timeline not contiguous`);
  }
  pump.stop();
});

test('dry queue recovery: clamps to now + minLead after silence', () => {
  const ctx = makeMockCtx(0);
  const pump = createAudioPump(ctx, { targetLead: 0.04, minLead: 0.005, maxLead: 0.20 });
  pump.start();
  pump.push(makeBuffer(0.01));
  pump.processTicks();
  // Queue ran dry; audio context advances by 0.5s (silence).
  ctx.advance(0.5);
  // nextStartTime was 0.05, currentTime is 0.5 -> clamp to 0.505.
  pump.push(makeBuffer(0.01));
  pump.processTicks();
  assert.equal(ctx._scheduled.length, 2);
  assert.ok(ctx._scheduled[1].startedAt >= 0.5 - 1e-9,
    `clamp expected >= 0.5, got ${ctx._scheduled[1].startedAt}`);
  approxEqual(ctx._scheduled[1].startedAt, 0.505, 1e-3);
  pump.stop();
});

test('max lead: scheduler does not schedule beyond now + maxLead', () => {
  const ctx = makeMockCtx(0);
  const pump = createAudioPump(ctx, { targetLead: 0.10, minLead: 0.005, maxLead: 0.16 });
  pump.start();
  // Four 0.05s buffers, qd 0.20. Cap with maxLead 0.16: drop 1 -> queue 3 (qd 0.15).
  // Prime 0.10, schedule:
  //   iter1: start 0.10, lead 0.10 <= 0.16 -> OK. nextStart 0.15.
  //   iter2: start 0.15, lead 0.15 <= 0.16 -> OK. nextStart 0.20.
  //   iter3: start 0.20, lead 0.20 > 0.16 -> BREAK. 1 buffer remains queued.
  for (let i = 0; i < 4; i += 1) pump.push(makeBuffer(0.05));
  pump.processTicks();
  assert.equal(ctx._scheduled.length, 2);
  approxEqual(ctx._scheduled[0].startedAt, 0.10);
  approxEqual(ctx._scheduled[1].startedAt, 0.15);
  assert.equal(pump.queueLength, 1);
  // Advance time so the next tick can schedule the remaining buffer.
  ctx.advance(0.15);  // currentTime 0.15
  pump.processTicks();
  // nextStartTime 0.20, now 0.15, lead 0.05 <= 0.16 -> schedule at 0.20, queue empty.
  assert.equal(ctx._scheduled.length, 3);
  approxEqual(ctx._scheduled[2].startedAt, 0.20);
  pump.stop();
});

test('stop: resets state and stops scheduling', () => {
  const ctx = makeMockCtx(0);
  const pump = createAudioPump(ctx);
  pump.start();
  pump.push(makeBuffer(0.01));
  pump.processTicks();
  assert.equal(ctx._scheduled.length, 1);
  pump.stop();
  pump.push(makeBuffer(0.02));
  pump.processTicks();
  // After stop, push/processTicks must not schedule (running=false).
  assert.equal(ctx._scheduled.length, 1);
  assert.equal(pump.running, false);
  assert.equal(pump.queueLength, 1);  // pushed buffer remained queued
  assert.equal(pump.nextStartTime, -1);
});
