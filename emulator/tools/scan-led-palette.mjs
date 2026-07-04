#!/usr/bin/env node
/*
 * Catalog every pad/step LED colour INDEX the Move engine actually emits.
 *
 * Move drives pad and step LEDs with a 7-bit colour *index* (the note velocity),
 * not an RGB triple. led-capture.mjs only knows a handful of documented indices
 * (red 0x7f, yellow 0x4f, green 0x7e, cyan 0x5f, blue 0x7d, purple 0x6f, a few
 * whites); every other index is currently faked with a golden-angle HSL hue, so
 * Session clip colours and other states render as arbitrary tints rather than
 * Move's real palette.
 *
 * This scanner sweeps the engine through Set Overview, all four tracks in Note
 * mode, and Session mode, and aggregates every distinct index it sees together
 * with the contexts it appears in. The output is the calibration worklist: the
 * exact set of indices we must map to real RGB (from a hardware capture or the
 * firmware palette) to replace the fake HSL fallback.
 *
 * It does NOT invent RGB values — it only reports which indices are in use and
 * whether led-capture.mjs currently has a real mapping for each.
 *
 * Usage:
 *   node emulator/tools/scan-led-palette.mjs [--url http://127.0.0.1:9090] [--json]
 */

const DEFAULT_BASE_URL = process.env.MOVE_SURFACE_URL || 'http://127.0.0.1:9090';

// Indices for which led-capture.mjs has a REAL (documented) colour, not the
// golden-angle HSL fallback. Keep in sync with velocityColor() there.
const DOCUMENTED_INDICES = new Set([
  0x00, // off
  0x01, 0x02, 0x03, // dim "available"
  0x7f, 0x4f, 0x7e, 0x5f, 0x7d, 0x6f, // red/yellow/green/cyan/blue/purple
  0x78, 0x7a, 0x7b, 0x7c, // white variants
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function padIdForIndex(index) {
  const row = Math.floor(index / 8);
  const col = index % 8;
  return 0x5c - row * 8 + col;
}
const PAD_IDS = Array.from({ length: 32 }, (_, i) => padIdForIndex(i));
const STEP_IDS = Array.from({ length: 16 }, (_, i) => 0x10 + i);

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), options);
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} -> HTTP ${response.status}`);
  return response.json();
}

async function control(baseUrl, event) {
  await requestJson(baseUrl, '/api/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
}

async function press(baseUrl, id, holdMs = 80) {
  await control(baseUrl, { type: 'button', id, action: 'press' });
  await sleep(holdMs);
  await control(baseUrl, { type: 'button', id, action: 'release' });
}

async function shiftStep(baseUrl, index) {
  await control(baseUrl, { type: 'button', id: 'shift', action: 'press' });
  await sleep(60);
  await control(baseUrl, { type: 'step', index, action: 'press' });
  await sleep(80);
  await control(baseUrl, { type: 'step', index, action: 'release' });
  await sleep(60);
  await control(baseUrl, { type: 'button', id: 'shift', action: 'release' });
}

async function currentMode(baseUrl) {
  const leds = await requestJson(baseUrl, '/api/leds');
  const cc = Number((leds.ccs || {})[0x32]);
  return Number.isFinite(cc) && cc >= 125 ? 'session' : 'note';
}

// Drive the engine into a known Note mode (Track 1), then optionally toggle to
// Session, using the CC 0x32 mode signal so we do not depend on a blind toggle.
async function ensureMode(baseUrl, target) {
  if ((await currentMode(baseUrl)) !== 'note') {
    await press(baseUrl, 'session');
    await sleep(300);
  }
  await press(baseUrl, 'track1');
  await sleep(300);
  if (target === 'session' && (await currentMode(baseUrl)) !== 'session') {
    await press(baseUrl, 'session');
    await sleep(300);
  }
}

// Record every distinct index seen on pads and steps in the current snapshot,
// tagging each with the given context label.
async function record(baseUrl, label, catalog) {
  const leds = await requestJson(baseUrl, '/api/leds');
  const vel = leds.noteVelocities || {};
  const note = (id) => {
    const v = Number(vel[id]);
    if (!Number.isFinite(v)) return;
    const entry = catalog.get(v) || { index: v, count: 0, contexts: new Set() };
    entry.count += 1;
    entry.contexts.add(label);
    catalog.set(v, entry);
  };
  PAD_IDS.forEach(note);
  STEP_IDS.forEach(note);
}

async function sweep(baseUrl) {
  const catalog = new Map();

  await ensureMode(baseUrl, 'note');
  await record(baseUrl, 'note:track1', catalog);
  for (const track of ['track2', 'track3', 'track4']) {
    await press(baseUrl, track);
    await sleep(350);
    await record(baseUrl, `note:${track}`, catalog);
  }

  await ensureMode(baseUrl, 'session');
  await record(baseUrl, 'session', catalog);
  // Nudge the session view so clips in other tracks/scenes come into range.
  for (const nav of ['right', 'plus', 'left', 'minus']) {
    await press(baseUrl, nav);
    await sleep(300);
    await record(baseUrl, `session:${nav}`, catalog);
  }

  // Set Overview (Shift+Step 1): the 32 pads become Set slots with their own
  // colour indices.
  await shiftStep(baseUrl, 0);
  await sleep(400);
  await record(baseUrl, 'set-overview', catalog);

  return catalog;
}

function summarize(catalog) {
  const rows = [...catalog.values()].sort((a, b) => a.index - b.index);
  return rows.map((row) => ({
    index: row.index,
    hex: `0x${row.index.toString(16).padStart(2, '0')}`,
    count: row.count,
    documented: DOCUMENTED_INDICES.has(row.index),
    contexts: [...row.contexts].sort(),
  }));
}

function printReport(rows) {
  const uncalibrated = rows.filter((r) => !r.documented && r.index > 3);
  console.log(`\nDistinct LED colour indices emitted: ${rows.length}`);
  console.log(`Indices with a REAL mapping in led-capture.mjs: ${rows.filter((r) => r.documented).length}`);
  console.log(`Indices still faked by golden-angle HSL (need calibration): ${uncalibrated.length}\n`);
  console.log('index  hex   mapped?   contexts');
  console.log('-----  ----  --------  --------');
  for (const r of rows) {
    const flag = r.documented ? 'real' : (r.index <= 3 ? 'dim' : 'FAKE');
    console.log(
      `${String(r.index).padStart(5)}  ${r.hex}  ${flag.padEnd(8)}  ${r.contexts.join(', ')}`,
    );
  }
  if (uncalibrated.length) {
    console.log('\nCalibration worklist (indices to resolve to real RGB):');
    console.log('  ' + uncalibrated.map((r) => r.hex).join(' '));
  }
}

async function main(argv) {
  let baseUrl = DEFAULT_BASE_URL;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') baseUrl = argv[++i];
    else if (argv[i] === '--json') json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node emulator/tools/scan-led-palette.mjs [--url URL] [--json]');
      return;
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  const rows = summarize(await sweep(baseUrl));
  if (json) console.log(JSON.stringify({ baseUrl, indices: rows }, null, 2));
  else printReport(rows);
}

export { padIdForIndex, summarize, DOCUMENTED_INDICES };

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
