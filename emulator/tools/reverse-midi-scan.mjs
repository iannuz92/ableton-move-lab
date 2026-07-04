import { appendFile, mkdir, open, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { SPI_RECORD_HEADER_SIZE, SPI_RECORD_SIZE, parseDisplayCapture } from '../lib/display-capture.mjs';
import { emptyLedState, processFrame } from '../lib/led-capture.mjs';

const root = new URL('..', import.meta.url).pathname;
const inputPath = join(root, 'input', 'midi.bin');
const txPath = join(root, 'spi', 'tx-packets.bin');
const outDir = join(root, 'reverse-captures');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ledCache = { offset: 0, state: emptyLedState() };

function packet(status, data1, data2) {
  const type = status & 0xf0;
  const cin = type === 0x80 ? 0x08 : type === 0x90 ? 0x09 : type === 0xa0 ? 0x0a : 0x0b;
  return Buffer.from([cin, status, data1 & 0x7f, data2 & 0x7f]);
}

function releasePacket(item) {
  if (item.kind === 'cc') return packet(0xb0, item.number, 0x00);
  if (item.kind === 'note-on') return packet(0x80, item.number, 0x00);
  return null;
}

function hashFrame(display) {
  if (!display || !display.available || !display.framebuffer) return null;
  return createHash('sha256').update(display.framebuffer).digest('hex').slice(0, 16);
}

function stable(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stable);
  return Object.fromEntries(Object.keys(value).sort((a, b) => Number(a) - Number(b)).map((k) => [k, stable(value[k])]));
}

function diffMap(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diff = {};
  for (const key of [...keys].sort((a, b) => Number(a) - Number(b))) {
    const a = JSON.stringify(before[key]);
    const b = JSON.stringify(after[key]);
    if (a !== b) diff[key] = { before: before[key] ?? null, after: after[key] ?? null };
  }
  return diff;
}

async function readTail(path, maxBytes) {
  const handle = await open(path, 'r');
  try {
    const details = await handle.stat();
    const wantedStart = Math.max(0, details.size - maxBytes);
    const start = wantedStart - (wantedStart % SPI_RECORD_SIZE);
    const length = details.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { buffer, fileSize: details.size };
  } finally {
    await handle.close();
  }
}

async function readDisplay() {
  try {
    const { buffer, fileSize } = await readTail(txPath, SPI_RECORD_SIZE * 2048);
    return parseDisplayCapture(buffer, fileSize);
  } catch {
    return null;
  }
}

async function readLeds() {
  let size = 0;
  try { size = (await stat(txPath)).size; } catch { return ledCache.state; }
  if (size < ledCache.offset) {
    ledCache.offset = 0;
    ledCache.state = emptyLedState();
  }
  if (size <= ledCache.offset) return ledCache.state;

  let handle;
  try {
    handle = await open(txPath, 'r');
    const length = size - ledCache.offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, ledCache.offset);
    let pos = 0;
    while (pos + SPI_RECORD_HEADER_SIZE <= buffer.length) {
      const dataLen = buffer.readUInt32LE(pos + 16);
      const recEnd = pos + SPI_RECORD_HEADER_SIZE + dataLen;
      if (dataLen <= 0 || recEnd > buffer.length) break;
      processFrame(buffer.subarray(pos + SPI_RECORD_HEADER_SIZE, pos + SPI_RECORD_HEADER_SIZE + 0x50), ledCache.state);
      pos = recEnd;
    }
    ledCache.offset += pos;
  } catch {
    return ledCache.state;
  } finally {
    if (handle) await handle.close();
  }
  return ledCache.state;
}

async function snapshot() {
  let display = null;
  let leds = { notes: {}, ccs: {} };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    [display, leds] = await Promise.all([readDisplay(), readLeds()]);
    if (display?.available) break;
    await sleep(80);
  }
  let midiBytes = 0;
  try { midiBytes = (await stat(inputPath)).size; } catch {}
  return {
    at: new Date().toISOString(),
    displayHash: hashFrame(display),
    displaySequence: display?.lastSequence ?? null,
    txBytes: display?.txBytes ?? null,
    midiBytes,
    leds: stable(leds || { notes: {}, ccs: {} }),
  };
}

async function sendRaw(bytes) {
  await appendFile(inputPath, bytes);
}

async function sendSequence(item, interPacketMs) {
  const packets = item.packets || [item.bytes];
  for (const bytes of packets) {
    await sendRaw(bytes);
    if (interPacketMs > 0) await sleep(interPacketMs);
  }
}

async function settleAfter(before, samples, sampleMs) {
  let best = await snapshot();
  let bestScore = -1;
  for (let i = 0; i < samples; i += 1) {
    await sleep(sampleMs);
    const candidate = await snapshot();
    const noteDiff = Object.keys(diffMap(before.leds.notes || {}, candidate.leds.notes || {})).length;
    const ccDiff = Object.keys(diffMap(before.leds.ccs || {}, candidate.leds.ccs || {})).length;
    const displayDiff = before.displayHash !== candidate.displayHash ? 1 : 0;
    const score = noteDiff + ccDiff + displayDiff;
    if (score >= bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function knownCases() {
  const cc = (name, n, value = 0x7f, release = true) => {
    const item = { name, bytes: packet(0xb0, n, value), kind: 'cc', number: n, value };
    if (release) item.packets = [item.bytes, releasePacket(item)];
    return item;
  };
  const note = (name, n, velocity = 0x7f, release = true) => {
    const item = { name, bytes: packet(0x90, n, velocity), kind: 'note-on', number: n, value: velocity };
    if (release) item.packets = [item.bytes, releasePacket(item)];
    return item;
  };
  return [
    cc('wheel-press', 0x03),
    cc('wheel-rotate-cw', 0x0e, 0x01, false),
    cc('wheel-rotate-ccw', 0x0e, 0x7f, false),
    cc('shift', 0x31),
    cc('mode', 0x32),
    cc('back-standalone-candidate', 0x33),
    cc('capture', 0x34),
    cc('minus', 0x36),
    cc('plus', 0x37),
    cc('undo', 0x38),
    cc('loop', 0x3a),
    cc('copy', 0x3c),
    cc('left', 0x3e),
    cc('right', 0x3f),
    cc('track4-bottom', 0x28),
    cc('track3', 0x29),
    cc('track2', 0x2a),
    cc('track1-top', 0x2b),
    cc('encoder1-cw', 0x47, 0x01),
    cc('encoder8-ccw', 0x4e, 0x7f),
    cc('volume-cw', 0x4f, 0x01),
    cc('play', 0x55),
    cc('record', 0x56),
    cc('mute', 0x58),
    cc('sample', 0x76),
    cc('delete', 0x77),
    note('step-1', 0x10),
    note('step-16', 0x1f),
    note('pad-bottom-left-doc', 0x44, 100),
    note('pad-top-left-doc', 0x5c, 100),
  ];
}

function scanCcCases() {
  const out = [];
  for (let n = 0; n <= 0x7f; n += 1) {
    const item = { name: `cc-${n.toString(16).padStart(2, '0')}-press-release`, bytes: packet(0xb0, n, 0x7f), kind: 'cc', number: n, value: 0x7f };
    item.packets = [item.bytes, releasePacket(item)];
    out.push(item);
  }
  return out;
}

function scanNoteCases() {
  const out = [];
  for (let n = 0; n <= 0x7f; n += 1) {
    const item = { name: `note-${n.toString(16).padStart(2, '0')}-on-off`, bytes: packet(0x90, n, 0x64), kind: 'note-on', number: n, value: 0x64 };
    item.packets = [item.bytes, releasePacket(item)];
    out.push(item);
  }
  return out;
}

async function run() {
  const mode = process.argv[2] || 'known';
  const waitMs = Number(process.env.REVERSE_SCAN_WAIT_MS || 300);
  const samples = Number(process.env.REVERSE_SCAN_SAMPLES || 4);
  const interPacketMs = Number(process.env.REVERSE_SCAN_INTER_PACKET_MS || 90);
  const quiet = process.env.REVERSE_SCAN_QUIET === '1';
  const cases = mode === 'scan-cc' ? scanCcCases() : mode === 'scan-notes' ? scanNoteCases() : knownCases();
  await mkdir(outDir, { recursive: true });
  const outputPath = join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}.jsonl`);

  const header = { type: 'header', mode, waitMs, samples, interPacketMs, cases: cases.length, inputPath, txPath };
  await writeFile(outputPath, `${JSON.stringify(header)}\n`);
  console.log(JSON.stringify(header));

  for (const item of cases) {
    const before = await snapshot();
    await sendSequence(item, interPacketMs);
    const after = await settleAfter(before, samples, waitMs);
    const result = {
      type: 'case',
      name: item.name,
      kind: item.kind,
      number: item.number,
      value: item.value,
      midi: (item.packets || [item.bytes]).map((bytes) => [...bytes]),
      displayChanged: before.displayHash !== after.displayHash,
      displayBefore: before.displayHash,
      displayAfter: after.displayHash,
      ledNotesDiff: diffMap(before.leds.notes || {}, after.leds.notes || {}),
      ledCcsDiff: diffMap(before.leds.ccs || {}, after.leds.ccs || {}),
      txDelta: after.txBytes != null && before.txBytes != null ? after.txBytes - before.txBytes : null,
      midiDelta: after.midiBytes - before.midiBytes,
    };
    await appendFile(outputPath, `${JSON.stringify(result)}\n`);
    if (!quiet) console.log(JSON.stringify(result));
  }
  console.error(`wrote ${outputPath}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
