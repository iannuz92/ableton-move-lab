import { appendFile, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  SPI_RECORD_SIZE,
  parseDisplayCapture,
} from './lib/display-capture.mjs';
import { usbMidiPacket } from './lib/control-midi.mjs';
import { processFrame, emptyLedState } from './lib/led-capture.mjs';
import {
  alignPcmByteLength,
} from './lib/audio-stream.mjs';

const execFileAsync = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = join(root, 'public');
const inputRoot = join(root, 'input');
const spiRoot = join(root, 'spi');
const port = Number(process.env.PORT || 9090);
const userDataRoot = process.env.MOVE_USER_DATA_DIR || '/data/UserData';
const userLibraryRoot = process.env.MOVE_USER_LIBRARY_DIR || join(userDataRoot, 'UserLibrary');
const setsRoot = process.env.MOVE_SETS_DIR || join(userLibraryRoot, 'Sets');
const settingsPath = process.env.MOVE_SETTINGS_PATH || join(userDataRoot, 'settings', 'Settings.json');

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

await mkdir(inputRoot, { recursive: true });
await mkdir(spiRoot, { recursive: true });

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function processStatus() {
  try {
    await execFileAsync('pgrep', ['MoveLauncher']);
    return 'running';
  } catch {
    return 'waiting';
  }
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
    return { buffer, fileSize: details.size, start };
  } finally {
    await handle.close();
  }
}

async function readDisplayFrame() {
  const txPath = join(spiRoot, 'tx-packets.bin');
  const { buffer, fileSize } = await readTail(txPath, SPI_RECORD_SIZE * 1024);
  return parseDisplayCapture(buffer, fileSize);
}

// Read the currently loaded set's Song.abl (JSON) and turn each track's first
// non-empty clip into per-note step indices (1/16 grid).
let songCache = { at: 0, path: '', data: null };

// Last audio-playback telemetry reported by the browser worklet, for diagnosing
// underruns server-side without reading the browser console.
let audioTelemetry = { at: 0, stats: null };

async function maybeStat(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function findSongFiles(dir = setsRoot) {
  const result = [];
  async function walk(path) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile() && entry.name === 'Song.abl') {
        result.push(child);
      }
    }
  }
  await walk(dir);
  return result;
}

function setDirForSong(songPath) {
  return dirname(dirname(songPath));
}

async function readSongIndex(songPath) {
  try {
    const { stdout } = await execFileAsync('getfattr', [
      '-n', 'user.song-index', '--only-values', setDirForSong(songPath),
    ]);
    const value = Number(stdout.trim());
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

async function readCurrentSongIndex() {
  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    const value = Number(settings.currentSongIndex);
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

async function songFromNativeLogs() {
  const logs = [
    '/tmp/move-stdout.log',
    '/tmp/move-launcher-native.log',
    '/tmp/move-real.log',
    '/emulator/move-real.log',
  ];
  const matches = [];
  for (const logPath of logs) {
    try {
      const text = await readFile(logPath, 'utf8');
      for (const line of text.split('\n')) {
        const match = line.match(/About to load\s+"?(.+?Song\.abl)"?\s*$/);
        if (match) matches.push(match[1]);
      }
    } catch {}
  }
  for (const songPath of matches.sort().reverse()) {
    if (await maybeStat(songPath)) return songPath;
  }
  return null;
}

async function resolveNativeSongPath() {
  const songs = await findSongFiles();
  if (songs.length > 0) {
    const currentSongIndex = await readCurrentSongIndex();
    if (currentSongIndex !== null) {
      const indexed = await Promise.all(songs.map(async (path) => ({
        path,
        songIndex: await readSongIndex(path),
      })));
      const byXattr = indexed.find((entry) => entry.songIndex === currentSongIndex);
      if (byXattr) return byXattr.path;

      const byMtime = await Promise.all(songs.map(async (path) => ({
        path,
        mtimeMs: ((await maybeStat(path)) || { mtimeMs: 0 }).mtimeMs,
      })));
      byMtime.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
      if (byMtime[currentSongIndex]) return byMtime[currentSongIndex].path;
    }
  }

  const logged = await songFromNativeLogs();
  if (logged) return logged;

  if (songs.length === 0) return '';

  const newest = await Promise.all(songs.map(async (path) => ({
    path,
    mtimeMs: ((await maybeStat(path)) || { mtimeMs: 0 }).mtimeMs,
  })));
  newest.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  return newest[0].path;
}

async function readSongPatterns() {
  const songPath = await resolveNativeSongPath();
  if (!songPath) return { available: false };

  // Cache by path briefly (the file is large; re-read on set change).
  if (songCache.path === songPath && Date.now() - songCache.at < 3000) {
    return songCache.data;
  }
  const json = await readFile(songPath, 'utf8');
  const song = JSON.parse(json);
  const stepBeats = 0.25; // 1/16 note = 0.25 beat

  // Find a drum rack anywhere in a device tree and return its 16 cells'
  // receivingNote (cell index -> note), so the GUI maps pads to real sounds.
  function findDrumNotes(devices) {
    for (const dev of devices || []) {
      if (dev && dev.kind === 'drumRack' && Array.isArray(dev.chains)) {
        return dev.chains.map((c) => (c.drumZoneSettings && c.drumZoneSettings.receivingNote));
      }
      for (const ch of (dev && dev.chains) || []) {
        const found = findDrumNotes(ch.devices);
        if (found) return found;
      }
    }
    return null;
  }
  const tracks = (song.tracks || []).map((t, ti) => {
    let clip = null;
    for (const cs of t.clipSlots || []) {
      if (cs && cs.clip && cs.clip.notes && cs.clip.notes.length) { clip = cs.clip; break; }
    }
    const notes = {};
    let bars = 1;
    if (clip) {
      const endBeats = (clip.region && clip.region.end) || 4;
      bars = Math.max(1, Math.round(endBeats / 4));
      for (const nt of clip.notes) {
        const step = Math.round(nt.startTime / stepBeats);
        const key = nt.noteNumber;
        (notes[key] = notes[key] || []).push(step);
      }
    }
    const drumNotes = findDrumNotes(t.devices);
    return { index: ti, kind: t.kind, name: t.name, isSelected: !!t.isSelected, bars, notes, drumNotes };
  });
  const data = { available: true, path: songPath, tracks };
  songCache = { at: Date.now(), path: songPath, data };
  return data;
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function serveStatic(pathname, response) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const path = normalize(join(publicRoot, requested));
  if (!path.startsWith(publicRoot)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const details = await stat(path);
    if (!details.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
}

// Stress config for the autonomous main-thread stall test (see app.js).
let stressConfig = { ms: 0, period: 250 };

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  // Cross-origin isolation so the page can use SharedArrayBuffer for the
  // off-main-thread audio path. Everything served here is same-origin.
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  try {
    if (request.method === 'GET' && url.pathname === '/api/status') {
      sendJson(response, 200, {
        bridge: await processStatus(),
        midiBytesQueued: await fileSize(join(inputRoot, 'midi.bin')),
        capturedBytes: await fileSize(join(spiRoot, 'tx-packets.bin')),
        capturedAt: new Date().toISOString(),
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/audio/stream') {
      // Live PCM: tail /emulator/spi/audio.raw (16-bit LE stereo @ 44100,
      // written by the shim) and push new bytes as a never-ending chunked
      // response. The browser feeds these into the Web Audio API.
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      const path = join(spiRoot, 'audio.raw');
      let offset = await fileSize(path); // skip backlog; start from "now"
      let closed = false;
      request.on('close', () => { closed = true; });
      const buffer = Buffer.alloc(16384);
      const maxBacklog = 44100 * 4 * 8;
      let handle = null;
      let lastSize = offset;
      while (!closed) {
        let size = 0;
        try { size = (await stat(path)).size; } catch { size = 0; }
        if (size < lastSize) { // shim wrapped/truncated audio.raw
          offset = 0;
          if (handle) { try { await handle.close(); } catch {} handle = null; }
        }
        lastSize = size;
        if (size > offset) {
          if (size - offset > maxBacklog) {
            offset = size - Math.floor(maxBacklog);
            offset = alignPcmByteLength(offset);
          }
          try {
            if (!handle) handle = await open(path, 'r');
            const want = Math.min(size - offset, buffer.length);
            const { bytesRead } = await handle.read(buffer, 0, want, offset);
            const aligned = alignPcmByteLength(bytesRead);
            if (aligned > 0) {
              if (!response.write(buffer.subarray(0, aligned))) {
                await new Promise((r) => response.once('drain', r));
              }
              offset += aligned;
            }
          } catch {
            if (handle) { try { await handle.close(); } catch {} handle = null; }
            await new Promise((r) => setTimeout(r, 50));
          }
        } else {
          await new Promise((r) => setTimeout(r, 1));
        }
      }
      if (handle) { try { await handle.close(); } catch {} }
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/display') {
      try {
        sendJson(response, 200, await readDisplayFrame());
      } catch {
        response.writeHead(204).end();
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/leds') {
      sendJson(response, 200, {
        notes: ledState.notes,
        noteLeds: ledState.noteLeds,
        rgbLeds: ledState.rgbLeds,
        noteVelocities: ledState.noteVelocities,
        noteChannels: ledState.noteChannels,
        ccs: ledState.ccs,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/song') {
      try {
        sendJson(response, 200, await readSongPatterns());
      } catch (error) {
        sendJson(response, 200, { available: false, error: error.message });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/control') {
      const event = {
        ...(await readBody(request)),
        timestamp: Date.now(),
      };
      const packet = usbMidiPacket(event);
      await appendFile(join(inputRoot, 'events.ndjson'), `${JSON.stringify(event)}\n`);
      await appendFile(join(inputRoot, 'midi.bin'), packet);
      sendJson(response, 200, { ok: true, midi: [...packet] });
      return;
    }

    if (url.pathname === '/api/debug/stress') {
      if (request.method === 'POST') {
        const body = await readBody(request);
        stressConfig = { ms: Number(body.ms) || 0, period: Number(body.period) || 250 };
      }
      sendJson(response, 200, stressConfig);
      return;
    }

    if (url.pathname === '/api/debug/ledoffset') {
      const txPath = join(spiRoot, 'tx-packets.bin');
      let txSize = 0;
      try { txSize = (await stat(txPath)).size; } catch {}
      sendJson(response, 200, { ledOffset, txSize, behind: txSize - ledOffset });
      return;
    }

    if (url.pathname === '/api/audiostats') {
      if (request.method === 'POST') {
        audioTelemetry = { at: Date.now(), stats: await readBody(request) };
        sendJson(response, 200, { ok: true });
      } else {
        sendJson(response, 200, { ageMs: Date.now() - audioTelemetry.at, ...audioTelemetry });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/reset') {
      await writeFile(join(inputRoot, 'events.ndjson'), '');
      await writeFile(join(inputRoot, 'midi.bin'), Buffer.alloc(0));
      sendJson(response, 200, { ok: true });
      return;
    }

    await serveStatic(url.pathname, response);
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

/*
 * LED mirroring: the engine writes RGB LED feedback as MIDI into the TX frames
 * (transient events). Tail tx-packets.bin and keep a cumulative LED state that
 * the GUI polls via /api/leds.
 */
const ledState = emptyLedState();
let ledOffset = 0;
const SPI_HEADER_SIZE = 24;

async function pollLeds() {
  const path = join(spiRoot, 'tx-packets.bin');
  let size = 0;
  try { size = (await stat(path)).size; } catch { return; }
  if (size < ledOffset) ledOffset = 0; // file was reset (new session)
  if (size <= ledOffset) return;
  let handle;
  try {
    handle = await open(path, 'r');
    // Read in 4 MB chunks to avoid OOM on multi-hundred-MB files.
    const chunk = Math.min(4 * 1024 * 1024, size - ledOffset);
    const buffer = Buffer.alloc(chunk);
    await handle.read(buffer, 0, chunk, ledOffset);
    let pos = 0;
    while (pos + SPI_HEADER_SIZE <= buffer.length) {
      const dataLen = buffer.readUInt32LE(pos + 16);
      // Skip obviously corrupted records (a frame is at most ~200 KB).
      if (dataLen <= 0 || dataLen > 200 * 1024) { pos += SPI_HEADER_SIZE; continue; }
      const recEnd = pos + SPI_HEADER_SIZE + dataLen;
      if (recEnd > buffer.length) break; // partial record at chunk boundary
      const region = buffer.subarray(pos + SPI_HEADER_SIZE, pos + SPI_HEADER_SIZE + 0x50);
      processFrame(region, ledState);
      pos = recEnd;
    }
    const advanced = pos;
    ledOffset += advanced;
    if (advanced === 0 && ledOffset < size) {
      // Could not parse a single complete record from this chunk even though
      // data remains ahead. Skip one header-sized step so we don't loop forever
      // on corrupted bytes that look like valid-but-huge dataLen.
      ledOffset += SPI_HEADER_SIZE;
    }
  } catch (e) {
    console.error('pollLeds error:', e.message);
  } finally {
    if (handle) await handle.close();
  }
}

const listenHost = process.env.HOST || '0.0.0.0';
server.listen(port, listenHost, () => {
  console.log(`Move Virtual Surface: http://${listenHost}:${port}`);
  setInterval(() => { pollLeds().catch(() => {}); }, 30);
});
