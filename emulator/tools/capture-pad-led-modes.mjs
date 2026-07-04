#!/usr/bin/env node

const DEFAULT_BASE_URL = process.env.MOVE_SURFACE_URL || 'http://127.0.0.1:9090';
const PAD_COUNT = 32;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function padIdForIndex(index) {
  const row = Math.floor(index / 8);
  const col = index % 8;
  return 0x5c - row * 8 + col;
}

function hex(id) {
  return `0x${id.toString(16).padStart(2, '0')}`;
}

function rgbString(rgb) {
  return Array.isArray(rgb) ? rgb.join('/') : '-';
}

export function summarizePadLeds(leds) {
  const noteLeds = leds.noteLeds || {};
  const noteVelocities = leds.noteVelocities || {};
  const rgbLeds = leds.rgbLeds || {};
  const pads = Array.from({ length: PAD_COUNT }, (_, index) => {
    const id = padIdForIndex(index);
    const velocity = noteVelocities[id] ?? null;
    const noteRgb = noteLeds[id] || null;
    const rgbRgb = rgbLeds[id] || null;
    return { index, id, idHex: hex(id), velocity, noteRgb, rgbRgb };
  });
  return {
    pads,
    velocities: summarizeVelocities(pads),
  };
}

export function summarizeVelocities(pads) {
  const byVelocity = new Map();
  for (const pad of pads) {
    const key = pad.velocity === null ? 'missing' : String(pad.velocity);
    const entry = byVelocity.get(key) || { velocity: pad.velocity, count: 0, pads: [] };
    entry.count += 1;
    entry.pads.push(pad.index);
    byVelocity.set(key, entry);
  }
  return [...byVelocity.values()].sort((a, b) => {
    if (a.velocity === null) return 1;
    if (b.velocity === null) return -1;
    return a.velocity - b.velocity;
  });
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), options);
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed: HTTP ${response.status}`);
  }
  return response.json();
}

async function control(baseUrl, event) {
  await requestJson(baseUrl, '/api/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
}

async function pressButton(baseUrl, id, holdMs = 80) {
  await control(baseUrl, { type: 'button', id, action: 'press' });
  await sleep(holdMs);
  await control(baseUrl, { type: 'button', id, action: 'release' });
}

async function pressStep(baseUrl, index, holdMs = 80) {
  await control(baseUrl, { type: 'step', index, action: 'press' });
  await sleep(holdMs);
  await control(baseUrl, { type: 'step', index, action: 'release' });
}

async function shiftStep(baseUrl, index) {
  await control(baseUrl, { type: 'button', id: 'shift', action: 'press' });
  await sleep(60);
  await pressStep(baseUrl, index);
  await sleep(60);
  await control(baseUrl, { type: 'button', id: 'shift', action: 'release' });
}

async function snapshot(baseUrl, label) {
  const [leds, display] = await Promise.all([
    requestJson(baseUrl, '/api/leds'),
    fetch(new URL('/api/display', baseUrl)).then((response) => (
      response.status === 204 ? null : response.json()
    )).catch(() => null),
  ]);
  const summary = summarizePadLeds(leds);
  return {
    at: new Date().toISOString(),
    label,
    display: display && {
      available: !!display.available,
      lastSequence: display.lastSequence ?? null,
      width: display.width ?? null,
      height: display.height ?? null,
    },
    velocities: summary.velocities,
    pads: summary.pads,
  };
}

function printSnapshot(result) {
  console.log(`\n=== ${result.label} @ ${result.at} ===`);
  if (result.display) {
    console.log(`display available=${result.display.available} seq=${result.display.lastSequence}`);
  }
  console.log('velocities:');
  for (const entry of result.velocities) {
    console.log(`  ${entry.velocity ?? 'missing'}: count=${entry.count} pads=[${entry.pads.join(',')}]`);
  }
  console.log('pads:');
  for (const pad of result.pads) {
    console.log(
      `  pad ${String(pad.index).padStart(2, ' ')} ${pad.idHex}` +
      ` vel=${pad.velocity ?? '-'} note=${rgbString(pad.noteRgb)} rgb=${rgbString(pad.rgbRgb)}`,
    );
  }
}

async function automaticRun(baseUrl) {
  const results = [];
  results.push(await snapshot(baseUrl, 'current'));

  await shiftStep(baseUrl, 0);
  await sleep(500);
  results.push(await snapshot(baseUrl, 'set-overview: shift+step1'));

  await pressButton(baseUrl, 'track1');
  await sleep(500);
  results.push(await snapshot(baseUrl, 'note-mode: track1'));

  await pressButton(baseUrl, 'session');
  await sleep(500);
  results.push(await snapshot(baseUrl, 'session-toggle'));

  await pressButton(baseUrl, 'note');
  await sleep(500);
  results.push(await snapshot(baseUrl, 'note-toggle-back'));

  return results;
}

async function watchRun(baseUrl, seconds) {
  const until = Date.now() + seconds * 1000;
  let index = 0;
  while (Date.now() < until) {
    printSnapshot(await snapshot(baseUrl, `watch-${index}`));
    index += 1;
    await sleep(1000);
  }
}

function usage() {
  console.error([
    'Usage:',
    '  node emulator/tools/capture-pad-led-modes.mjs [--url http://127.0.0.1:9090] [--json]',
    '  node emulator/tools/capture-pad-led-modes.mjs --watch 30 [--url http://127.0.0.1:9090]',
  ].join('\n'));
}

async function main(argv) {
  let baseUrl = DEFAULT_BASE_URL;
  let json = false;
  let watchSeconds = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') {
      baseUrl = argv[++i];
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--watch') {
      watchSeconds = Number(argv[++i] || 0);
    } else if (arg === '--help' || arg === '-h') {
      usage();
      return;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (watchSeconds > 0) {
    await watchRun(baseUrl, watchSeconds);
    return;
  }

  const results = await automaticRun(baseUrl);
  if (json) {
    console.log(JSON.stringify({ baseUrl, results }, null, 2));
  } else {
    for (const result of results) printSnapshot(result);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
