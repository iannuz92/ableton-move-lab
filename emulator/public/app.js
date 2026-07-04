import { createWheelNormalizer } from './wheel-normalizer.mjs';
import { stepViewKey, setStepOverride, reconcileOverlay, applyStepOverlay } from './step-led-overlay.mjs';
import { hexToRgb, padLedRgb, padIsAnimated } from './pad-led-render.mjs';
import { createAudioPump } from './audio-pump.mjs';

const $ = (selector) => document.querySelector(selector);
const pads = $('#pads');
const steps = $('#steps');
const encoderBank = $('#encoder-bank');
const trackButtons = $('#track-buttons');
const lastInput = $('#last-input');
const canvas = $('#display');
const context = canvas.getContext('2d');

const padColors = ['#f58cff', '#edf4fa', '#edf4fa', '#edf4fa', '#edf4fa', '#edf4fa', '#edf4fa', '#f58cff'];
const trackColors = ['#3869ff', '#f45bff', '#ff5a4d', '#78f45b'];
const state = {
  realDisplay: null,
  realDisplaySequence: 0,
  engineStepLedAuthority: false,
  localShiftHeld: false,
  stepFunctionMode: false,
};
const optimisticStepLeds = new Map();
let effectiveTrack = 0;
context.imageSmoothingEnabled = false;

async function emit(event) {
  lastInput.textContent = `${event.type.toUpperCase()} / ${event.id ?? event.index ?? ''}`;
  try {
    await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
  } catch (e) { console.error('emit failed', e); }
}

function drawDisplay() {
  if (state.realDisplay) {
    drawRealDisplay(state.realDisplay);
    return;
  }

  context.fillStyle = '#10170f';
  context.fillRect(0, 0, 128, 64);
}

function drawRealDisplay(framebuffer) {
  context.fillStyle = '#10170f';
  context.fillRect(0, 0, 128, 64);
  context.fillStyle = '#d7ff98';

  for (let page = 0; page < 8; page += 1) {
    for (let x = 0; x < 128; x += 1) {
      const byte = framebuffer[page * 128 + x] || 0;
      if (!byte) continue;
      for (let bit = 0; bit < 8; bit += 1) {
        if (byte & (1 << bit)) {
          context.fillRect(x, page * 8 + bit, 1, 1);
        }
      }
    }
  }
}

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function makeButton(label, attributes = {}) {
  const button = document.createElement('button');
  button.textContent = label;
  Object.entries(attributes).forEach(([key, value]) => button.dataset[key] = value);
  return button;
}

for (let index = 0; index < 4; index += 1) {
  const button = makeButton('', { button: `track${index + 1}`, track: index + 1 });
  button.className = 'track-button';
  button.title = `Track ${index + 1}`;
  button.setAttribute('aria-label', `Track ${index + 1}`);
  button.style.setProperty('--track-color', trackColors[index]);
  trackButtons.append(button);
}

for (let index = 0; index < 8; index += 1) {
  const wrap = document.createElement('div');
  wrap.className = 'encoder-wrap';
  const encoder = document.createElement('div');
  encoder.className = 'encoder';
  encoder.tabIndex = 0;
  encoder.dataset.encoder = index;
  encoder.style.setProperty('--rotation', `${-125 + index * 9}deg`);
  const label = document.createElement('span');
  label.textContent = `P${index + 1}`;
  encoder.title = `Encoder ${index + 1}`;
  encoder.setAttribute('aria-label', `Encoder ${index + 1}`);
  wrap.append(encoder, label);
  encoderBank.append(wrap);
}

for (let index = 0; index < 16; index += 1) {
  const button = makeButton('', { step: index });
  button.className = 'step';
  button.title = `Step ${index + 1}`;
  steps.append(button);
}

for (let index = 0; index < 32; index += 1) {
  const button = makeButton('', { pad: index });
  button.className = 'pad';
  button.style.setProperty('--pad-color', padColors[index % 8]);
  button.title = `Pad ${index + 1}`;
  pads.append(button);
}

function velocityFromPointer(event, element) {
  const rect = element.getBoundingClientRect();
  const normalized = 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
  return Math.round(45 + normalized * 82);
}

document.addEventListener('pointerdown', (event) => {
  const pad = event.target.closest('[data-pad]');
  const button = event.target.closest('[data-button], [data-step], [data-track]');
  const unmapped = event.target.closest('[data-unmapped]');
  if (unmapped) {
    unmapped.classList.add('active');
    lastInput.textContent = `UNMAPPED / ${unmapped.dataset.unmapped}`;
    return;
  }
  if (pad) {
    pad.setPointerCapture(event.pointerId);
    pad.classList.add('active');
    selectedPad = Number(pad.dataset.pad); // show this sound's steps
    setTimeout(refreshSteps, 30);
    emit({ type: 'pad', index: Number(pad.dataset.pad), action: 'press', velocity: velocityFromPointer(event, pad) });
    return;
  }
  if (button) {
    button.classList.add('active');
    const id = button.dataset.button || `step${button.dataset.step}`;
    if (id === 'shift') {
      state.localShiftHeld = true;
      state.stepFunctionMode = true;
      optimisticStepLeds.clear();
      renderStepLights(new Set());
    }
    if (button.dataset.track) { state.track = Number(button.dataset.track); selectedTrack = state.track - 1; selectedPad = null; currentBar = 0; setTimeout(refreshSteps, 30); }
    if (id === 'left') { currentBar = Math.max(0, currentBar - 1); setTimeout(refreshSteps, 30); }
    if (id === 'right') { currentBar = Math.min(trackBars - 1, currentBar + 1); setTimeout(refreshSteps, 30); }
    const stepEvent = button.dataset.step !== undefined;
    if (stepEvent) {
      const stepIndex = Number(button.dataset.step);
      if (!state.engineStepLedAuthority && !state.stepFunctionMode) {
        const view = { trackIndex: effectiveTrack, padIndex: selectedPad, barIndex: currentBar };
        const lit = button.classList.toggle('lit');
        if (lit) button.style.setProperty('--led', '#edf4fa');
        else button.style.removeProperty('--led');
        setStepOverride(optimisticStepLeds, view, stepIndex, lit);
      }
    }
    emit({ type: stepEvent ? 'step' : 'button', id, index: Number(button.dataset.step || 0), action: 'press' }).then(() => { if (stepEvent) refreshSteps(); });
  }
});

document.addEventListener('pointerup', (event) => {
  const pad = event.target.closest('[data-pad]');
  const button = event.target.closest('[data-button], [data-step], [data-track]');
  const unmapped = event.target.closest('[data-unmapped]');
  if (unmapped) {
    unmapped.classList.remove('active');
    return;
  }
  if (pad) {
    pad.classList.remove('active');
    emit({ type: 'pad', index: Number(pad.dataset.pad), action: 'release', velocity: 0 });
  }
  if (button) {
    // `active` is only the momentary press feedback; remove it for every button
    // on release. Play/Record used to keep it as a sticky local toggle, which
    // made them look permanently on regardless of the engine's real state.
    // Their lit state now comes solely from the engine LED mirror.
    const id = button.dataset.button || `step${button.dataset.step}`;
    if (id === 'shift') {
      state.localShiftHeld = false;
      state.stepFunctionMode = false;
      setTimeout(refreshSteps, 80);
    }
    button.classList.remove('active');
    emit({ type: button.dataset.step !== undefined ? 'step' : 'button', id, index: Number(button.dataset.step || 0), action: 'release' });
  }
});

document.querySelectorAll('[data-encoder], .wheel').forEach((encoder) => {
  let rotation = -125;
  const isWheel = encoder.classList.contains('wheel');
  const wheelNormalizer = createWheelNormalizer();
  let touched = false;
  const touchPress = () => {
    if (touched) return;
    touched = true;
    if (isWheel) emit({ type: 'touch', id: 'wheel', action: 'press' });
    else emit({ type: 'touch', index: Number(encoder.dataset.encoder || 0), action: 'press' });
  };
  const touchRelease = () => {
    if (!touched) return;
    touched = false;
    if (isWheel) emit({ type: 'touch', id: 'wheel', action: 'release' });
    else emit({ type: 'touch', index: Number(encoder.dataset.encoder || 0), action: 'release' });
  };
  // Browsers (especially trackpads) can fire small deltas or one large delta.
  // Normalize both to at most one MIDI step per browser event, so menu
  // navigation never skips multiple entries on a single physical gesture.
  encoder.addEventListener('wheel', (event) => {
    event.preventDefault();
    const delta = wheelNormalizer.push(event.deltaY);
    if (delta === 0) return;
    touchPress();
    rotation = Math.max(-135, Math.min(135, rotation + delta * 12));
    encoder.style.setProperty('--rotation', `${rotation}deg`);
    encoder.classList.add('active');
    clearTimeout(encoder.releaseTimer);
    encoder.releaseTimer = setTimeout(() => {
      encoder.classList.remove('active');
      touchRelease();
    }, 130);
    // The big wheel navigates menus (its own CC); the 8 small encoders adjust
    // device parameters. They must not share a control number.
    if (isWheel) emit({ type: 'wheel', delta });
    else emit({ type: 'encoder', index: Number(encoder.dataset.encoder || 0), delta });
  }, { passive: false });
});

document.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  if (event.code === 'Space') $('[data-button="play"]').click();
  if (event.key.toLowerCase() === 'r') $('[data-button="record"]').click();
  if (/^[1-8]$/.test(event.key)) {
    const pad = $(`[data-pad="${Number(event.key) - 1}"]`);
    pad.classList.add('active');
    emit({ type: 'pad', index: Number(event.key) - 1, action: 'press', velocity: 100 });
  }
});

document.addEventListener('keyup', (event) => {
  if (/^[1-8]$/.test(event.key)) {
    const pad = $(`[data-pad="${Number(event.key) - 1}"]`);
    pad.classList.remove('active');
    emit({ type: 'pad', index: Number(event.key) - 1, action: 'release', velocity: 0 });
  }
});

$('#reset-queue').addEventListener('click', async () => {
  await fetch('/api/reset', { method: 'POST' });
  lastInput.textContent = 'QUEUE CLEARED';
});

// --- Live audio: 16-bit LE stereo @ 44100 streamed from /audio/stream ---
const audioToggle = $('#audio-toggle');
let audioCtx = null;
let audioOn = false;
let audioAbort = null;
let audioNode = null;
let audioWorker = null;
let audioWorkerProgress = null;
let audioPump = null;
let audioMode = 'off';
let audioStats = { bufferedFrames: 0, droppedFrames: 0, underrunFrames: 0 };
window.__moveAudioStats = audioStats;

function appendBytes(left, right) {
  if (!left.length) return right;
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
}

function postPcmToWorklet(bytes) {
  if (!audioNode || bytes.length === 0) return;
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  audioNode.port.postMessage({ type: 'pcm', buffer }, [buffer]);
}

function pcmBytesToAudioBuffer(bytes) {
  const frameCount = Math.floor(bytes.length / 4);
  const audioBuffer = audioCtx.createBuffer(2, frameCount, 44100);
  const left = audioBuffer.getChannelData(0);
  const right = audioBuffer.getChannelData(1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, frameCount * 4);
  for (let frame = 0; frame < frameCount; frame += 1) {
    left[frame] = view.getInt16(frame * 4, true) / 32768;
    right[frame] = view.getInt16(frame * 4 + 2, true) / 32768;
  }
  return audioBuffer;
}

async function reportBasicAudioStats(receivedBytes) {
  audioStats = {
    type: 'stats',
    mode: 'basic',
    receivedBytes,
    bufferedFrames: audioPump ? audioPump.queueLength * 4096 : 0,
    droppedFrames: 0,
    underrunFrames: 0,
    sourceSampleRate: 44100,
  };
  window.__moveAudioStats = audioStats;
  fetch('/api/audiostats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(audioStats),
  }).catch(() => {});
}

async function pumpAudioBasic(signal) {
  const response = await fetch('/audio/stream', { signal });
  if (!response.ok || !response.body) throw new Error(`audio stream HTTP ${response.status}`);
  const reader = response.body.getReader();
  let leftover = new Uint8Array(0);
  let pending = new Uint8Array(0);
  let receivedBytes = 0;
  let lastStatsAt = performance.now();
  const chunkBytes = 16384; // 4096 stereo frames, about 93 ms.

  while (audioOn && audioMode === 'basic') {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.length;
    const bytes = appendBytes(leftover, value);
    const usable = Math.floor(bytes.length / 4) * 4;
    leftover = bytes.slice(usable);
    if (usable === 0) continue;

    pending = appendBytes(pending, bytes.slice(0, usable));
    while (pending.length >= chunkBytes) {
      const chunk = pending.slice(0, chunkBytes);
      pending = pending.slice(chunkBytes);
      audioPump.push(pcmBytesToAudioBuffer(chunk));
    }

    const now = performance.now();
    if (now - lastStatsAt > 500) {
      lastStatsAt = now;
      await reportBasicAudioStats(receivedBytes);
    }
  }

  if (pending.length > 0 && audioOn && audioMode === 'basic') {
    audioPump.push(pcmBytesToAudioBuffer(pending));
  }
}

async function pumpAudio(signal) {
  const response = await fetch('/audio/stream', { signal });
  if (!response.ok || !response.body) throw new Error(`audio stream HTTP ${response.status}`);
  const reader = response.body.getReader();
  let leftover = new Uint8Array(0);
  let pending = new Uint8Array(0);
  let lastPostAt = performance.now();
  const postChunkBytes = 4096;
  while (audioOn) {
    const { done, value } = await reader.read();
    if (done) break;
    const bytes = appendBytes(leftover, value);
    const frames = Math.floor(bytes.length / 4); // 2ch * 16-bit
    const usable = frames * 4;
    leftover = bytes.slice(usable);
    if (frames === 0) continue;
    pending = appendBytes(pending, bytes.slice(0, usable));
    const now = performance.now();
    if (pending.length >= postChunkBytes || now - lastPostAt >= 20) {
      postPcmToWorklet(pending);
      pending = new Uint8Array(0);
      lastPostAt = now;
    }
  }
  postPcmToWorklet(pending);
}

async function startAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: 44100,
    latencyHint: 'interactive',
  });
  if (!audioCtx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
    await startBasicAudio();
    return;
  }

  try {
    await audioCtx.audioWorklet.addModule('/pcm-worklet.js?v=sab-worker-2');
  } catch (error) {
    console.warn('audio worklet unavailable, using basic fallback:', error);
    await startBasicAudio();
    return;
  }

  // Prefer the off-main-thread SAB path: a Web Worker fetches the stream into a
  // SharedArrayBuffer ring that the worklet reads directly, so UI rendering can
  // never starve audio. Falls back to the main-thread push path when the page
  // is not cross-origin isolated.
  const useSab = self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
  const RING_SAMPLES = 1 << 17; // 131072 samples = 65536 stereo frames (~1.5 s)
  let ringSab = null;
  let controlSab = null;
  if (useSab) {
    ringSab = new SharedArrayBuffer(RING_SAMPLES * 2);
    controlSab = new SharedArrayBuffer(16);
  }

  audioNode = new AudioWorkletNode(audioCtx, 'move-pcm-stream', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      sourceSampleRate: 44100,
      targetBufferFrames: 4096, // ~93 ms steady latency
      maxBufferFrames: 8192,    // ~186 ms hard cap; excess is dropped to target
      capacityFrames: 65536,
      ringSab,
      controlSab,
    },
  });

  let lastStatsPost = 0;
  audioNode.port.onmessage = (event) => {
    if (event.data && event.data.type === 'stats') {
      audioStats = { ...event.data, worker: audioWorkerProgress };
      window.__moveAudioStats = audioStats;
      const now = performance.now();
      if (now - lastStatsPost > 500) {
        lastStatsPost = now;
        fetch('/api/audiostats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(audioStats),
        }).catch(() => {});
      }
    }
  };
  audioNode.connect(audioCtx.destination);
  await audioCtx.resume();
  audioOn = true;
  audioMode = useSab ? 'sab' : 'push';
  audioToggle.textContent = useSab ? '🔊 audio on' : '🔊 audio on (no-SAB)';

  if (useSab) {
    audioWorker = new Worker('/audio-worker.js');
    audioWorker.onmessage = (event) => {
      const m = event.data || {};
      if (m.type === 'progress') audioWorkerProgress = m;
      else if (m.type === 'error') console.warn('audio-worker:', m.message);
    };
    audioWorker.postMessage({ type: 'start', ringSab, controlSab, url: '/audio/stream' });
  } else {
    audioAbort = new AbortController();
    pumpAudio(audioAbort.signal).catch(() => {});
  }
}

async function startBasicAudio() {
  audioPump = createAudioPump(audioCtx, {
    targetLead: 0.12,
    minLead: 0.03,
    maxLead: 0.5,
  });
  audioPump.start();
  await audioCtx.resume();
  audioOn = true;
  audioMode = 'basic';
  audioToggle.textContent = 'audio on (basic)';
  audioToggle.title = 'Basic audio fallback: no AudioWorklet required.';
  audioAbort = new AbortController();
  pumpAudioBasic(audioAbort.signal).catch((error) => {
    if (!audioOn) return;
    console.warn('basic audio:', error);
    audioToggle.textContent = 'audio err';
    audioToggle.title = error.message || String(error);
  });
}

function stopAudio() {
  audioOn = false;
  audioMode = 'off';
  if (audioAbort) audioAbort.abort();
  audioAbort = null;
  if (audioPump) {
    audioPump.stop();
    audioPump = null;
  }
  if (audioWorker) {
    audioWorker.postMessage({ type: 'stop' });
    audioWorker.terminate();
    audioWorker = null;
  }
  if (audioNode) {
    audioNode.port.postMessage({ type: 'reset' });
    audioNode.disconnect();
  }
  if (audioCtx) audioCtx.close();
  audioNode = null;
  audioCtx = null;
  audioToggle.textContent = 'audio off';
  audioToggle.title = '';
}

audioToggle.addEventListener('click', () => {
  if (audioOn) {
    stopAudio();
  } else {
    startAudio().catch((error) => {
      audioToggle.textContent = 'audio err';
      audioToggle.title = error.message || String(error);
      console.warn('audio start failed:', error);
    });
  }
});

function startAudioByDefault() {
  startAudio().catch((error) => {
    audioToggle.textContent = 'audio click';
    audioToggle.title = `Browser blocked automatic audio start: ${error.message || String(error)}`;
    console.warn('audio autoplay blocked:', error);
  });
}

async function refreshStatus() {
  try {
    const status = await fetch('/api/status').then((response) => response.json());
    $('#bridge-status').textContent = status.bridge;
    $('#status-dot').classList.toggle('online', status.bridge !== 'offline');
    $('#midi-count').textContent = `${status.midiBytesQueued} B`;
    $('#capture-count').textContent = `${status.capturedBytes} B`;
  } catch {
    $('#bridge-status').textContent = 'offline';
    $('#status-dot').classList.remove('online');
  }
}

async function refreshDisplay() {
  try {
    const response = await fetch('/api/display', { cache: 'no-store' });
    if (response.status === 204) return;
    const display = await response.json();
    if (!display.available || !display.framebuffer) return;
    if (display.lastSequence === state.realDisplaySequence) return;
    state.realDisplay = decodeBase64(display.framebuffer);
    state.realDisplaySequence = display.lastSequence;
    drawDisplay();
  } catch {}
}

// --- LED mirroring: reflect the engine's real RGB LED state (/api/leds) ---
// Pad note id (must match control-midi.mjs padNote): top row -> 0x5C..
function padIdForIndex(index) {
  const row = Math.floor(index / 8);
  const col = index % 8;
  return 0x5c - row * 8 + col;
}
// LED CC -> GUI button id(s). 0x32 is the single Note/Session toggle.
const ccToButtons = {
  0x03: ['wheelPress'],
  0x31: ['shift'], 0x32: ['note', 'session'], 0x34: ['capture'], 0x76: ['sample'],
  0x3a: ['loop'], 0x58: ['mute'], 0x77: ['delete'], 0x3c: ['copy'], 0x38: ['undo'],
  0x56: ['record'], 0x55: ['play'], 0x3e: ['left'], 0x3f: ['right'],
  0x36: ['minus'], 0x37: ['plus'], 0x33: ['back'],
  0x2b: ['track1'], 0x2a: ['track2'], 0x29: ['track3'], 0x28: ['track4'],
};

function applyLed(el, rgb) {
  if (!el) return;
  if (rgb && (rgb[0] || rgb[1] || rgb[2])) {
    el.style.setProperty('--led', `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`);
    el.classList.add('lit');
  } else {
    el.classList.remove('lit');
    el.style.removeProperty('--led');
  }
}

// Step trigger pattern: Move emits colored step LED values for several
// non-trigger states, so the virtual step row intentionally renders only the
// sequencer trigger pattern plus the local optimistic overlay.
let selectedTrack = null; // null = follow the engine's selected track
let selectedPad = null;   // GUI pad index whose sound's steps to show (null = all)
let currentBar = 0;
let trackBars = 1;

// Drum-cell index for the left 4x4 of pads (bottom-left = cell 0, +1 right,
// +4 up). The actual note comes from the drum rack's receivingNote list.
function drumCellForPad(index) {
  const row = Math.floor(index / 8);
  const col = index % 8;
  if (col > 3) return null;
  return (3 - row) * 4 + col;
}

function renderStepLights(litSteps) {
  document.querySelectorAll('[data-step]').forEach((el) => {
    const isLit = litSteps.has(Number(el.dataset.step));
    el.classList.toggle('lit', isLit);
    if (isLit) el.style.setProperty('--led', '#edf4fa');
    else el.style.removeProperty('--led');
  });
}

function renderEngineStepLeds(leds) {
  const noteLeds = leds.noteLeds || leds.notes || {};
  const noteVelocities = leds.noteVelocities || {};
  document.querySelectorAll('[data-step]').forEach((el) => {
    const id = 0x10 + Number(el.dataset.step);
    const rgb = noteLeds[id] || [0, 0, 0];
    const velocity = Number(noteVelocities[id] || 0);
    const isLit = velocity > 0 || !!(rgb[0] || rgb[1] || rgb[2]);
    el.classList.toggle('lit', isLit);
    if (isLit) el.style.setProperty('--led', `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`);
    else el.style.removeProperty('--led');
  });
}

function renderEngineStepTriggers(leds) {
  const noteLeds = leds.noteLeds || leds.notes || {};
  const noteVelocities = leds.noteVelocities || {};
  let hasStepContext = false;
  document.querySelectorAll('[data-step]').forEach((el) => {
    const id = 0x10 + Number(el.dataset.step);
    const velocity = Number(noteVelocities[id] || 0);
    if (velocity > 0) hasStepContext = true;
  });
  if (!hasStepContext) return false;

  document.querySelectorAll('[data-step]').forEach((el) => {
    const id = 0x10 + Number(el.dataset.step);
    const velocity = Number(noteVelocities[id] || 0);
    const rgb = noteLeds[id] || [0, 0, 0];
    const isTrigger = velocity >= 120;
    el.classList.toggle('lit', isTrigger);
    if (isTrigger) el.style.setProperty('--led', `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`);
    else el.style.removeProperty('--led');
  });
  return true;
}

async function refreshSteps() {
  // If Move emits actual lit step LEDs, keep those as the authority. Zero-only
  // step CCs are not enough: Move can send them while the selected clip still
  // contains notes, so the Song.abl fallback remains active in that case.
  if (state.engineStepLedAuthority || state.stepFunctionMode) return;
  try {
    const song = await fetch('/api/song', { cache: 'no-store' }).then((r) => r.json());
    if (!song.available || !song.tracks) {
      optimisticStepLeds.clear();
      renderStepLights(new Set());
      return;
    }
    let ti = selectedTrack;
    if (ti === null) {
      const sel = song.tracks.find((t) => t.isSelected);
      ti = sel ? sel.index : 0;
    }
    const track = song.tracks[ti];
    if (!track) return;
    trackBars = track.bars || 1;
    if (currentBar > trackBars - 1) currentBar = trackBars - 1;
    const base = currentBar * 16;

    // Which note(s) to show: a specific pad's sound if one is selected and it
    // matches a note in the clip (auto-detect drum vs melodic), else all sounds.
    let noteKeys = Object.keys(track.notes);
    if (selectedPad !== null) {
      const candidates = [];
      const cell = drumCellForPad(selectedPad);
      if (cell !== null && track.drumNotes && track.drumNotes[cell] != null) {
        candidates.push(String(track.drumNotes[cell])); // real drum-cell note
      }
      candidates.push(String(padIdForIndex(selectedPad))); // melodic fallback
      const hit = candidates.find((n) => track.notes[n]);
      noteKeys = hit ? [hit] : [];
    }

    const baseLit = new Set();
    for (const key of noteKeys) {
      for (const s of track.notes[key] || []) {
        if (s >= base && s < base + 16) baseLit.add(s - base);
      }
    }
    effectiveTrack = ti;
    const view = { trackIndex: ti, padIndex: selectedPad, barIndex: currentBar };
    reconcileOverlay(optimisticStepLeds, view, baseLit);
    const lit = applyStepOverlay(baseLit, optimisticStepLeds, view);
    renderStepLights(lit);
    const label = document.querySelector('.step-label span:last-child');
    if (label) label.textContent = trackBars > 1 ? `BAR ${currentBar + 1}/${trackBars}` : '01—16';
  } catch (e) { console.error('refreshSteps failed', e); }
}

async function refreshLeds() {
  try {
    const leds = await fetch('/api/leds', { cache: 'no-store' }).then((r) => r.json());
    const rgbLeds = leds.rgbLeds || {};
    // Mode signal: the Note/Session button LED (CC 0x32) sits dim (~24) in Note
    // mode and fully lit (127) in Session mode. Engine-driven, so it stays in
    // sync even when the mode changes from hardware, not just the GUI toggle.
    // In Session the pad grid is a clip matrix: empty slots must read as empty
    // (dark), not the decorative resting pad colour used in Note mode.
    const modeCc = Number((leds.ccs || {})[0x32]);
    state.sessionMode = Number.isFinite(modeCc) && modeCc >= 125;
    if (pads) pads.classList.toggle('session', state.sessionMode);
    // The engine drives the 9 encoder rings via ids 0x47-0x4F (real feedback).
    document.querySelectorAll('[data-encoder]').forEach((el) => {
      applyLed(el, rgbLeds[0x47 + Number(el.dataset.encoder)]);
    });
    document.querySelectorAll('[data-pad]').forEach((el) => {
      const trackIndex = selectedTrack ?? effectiveTrack ?? 0;
      const id = padIdForIndex(Number(el.dataset.pad));
      applyLed(el, padLedRgb(leds, id, {
        trackIndex,
        fallbackTrackRgb: hexToRgb(trackColors[trackIndex] || trackColors[0]),
      }));
      // Animate playing/queued clips (non-zero note channel) so they read
      // differently from solid stopped clips.
      el.classList.toggle('pulse', padIsAnimated(leds, id, el.classList.contains('lit')));
    });
    const ccs = leds.ccs || {};
    const shiftCc = Number(ccs[0x31]);
    const shiftHeld = state.localShiftHeld || (Number.isFinite(shiftCc) && shiftCc > 124);
    if (shiftHeld) {
      state.stepFunctionMode = true;
      state.engineStepLedAuthority = false;
      optimisticStepLeds.clear();
      renderEngineStepLeds(leds);
    } else if (state.stepFunctionMode) {
      state.stepFunctionMode = false;
      setTimeout(refreshSteps, 30);
    } else if (renderEngineStepTriggers(leds)) {
      state.engineStepLedAuthority = true;
      optimisticStepLeds.clear();
    } else if (state.engineStepLedAuthority) {
      state.engineStepLedAuthority = false;
      setTimeout(refreshSteps, 30);
    }
    for (const [cc, val] of Object.entries(ccs)) {
      const n = Number(cc);
      if (n >= 0x10 && n <= 0x1f) {
        continue;
      }
      // The engine encodes button LEDs as a brightness, not a binary: 0 = off,
      // ~24 = dim "available", ~124 = transport idle (Play/Record sit here when
      // stopped), and 126/127 = actively engaged. Treating any non-zero value
      // as lit (the old behaviour) made Play/Record look permanently on. Light
      // a button only when it is actually engaged, i.e. brighter than the idle
      // levels.
      (ccToButtons[Number(cc)] || []).forEach((bid) => {
        document.querySelectorAll(`[data-button="${bid}"]`).forEach((el) => {
          el.classList.toggle('lit', Number(val) > 124);
        });
      });
    }
  } catch {}
}

drawDisplay();
refreshStatus();
refreshDisplay();
refreshLeds();
refreshSteps();
setTimeout(startAudioByDefault, 250);
// Polling cadence is deliberately conservative: these handlers run on the main
// thread that also feeds the audio worklet, and heavy ones (display canvas,
// step-grid DOM rebuild) stall it long enough to starve the audio buffer.
setInterval(refreshStatus, 1500);
setInterval(refreshDisplay, 500);
setInterval(refreshLeds, 120);
setInterval(refreshSteps, 3000);

// --- Diagnostic: server-controlled main-thread stress, for autonomous testing.
// GET /api/debug/stress returns {ms, period}; while ms>0 we busy-wait `ms` every
// `period` ms ON THE MAIN THREAD, reproducing the stalls heavy UI use causes.
// With the SAB audio path this must NOT affect playback.
let stressConfig = { ms: 0, period: 250 };
let stressTimer = null;
function applyStress() {
  if (stressTimer) { clearInterval(stressTimer); stressTimer = null; }
  if (stressConfig.ms > 0) {
    stressTimer = setInterval(() => {
      const until = performance.now() + stressConfig.ms;
      while (performance.now() < until) { /* block the main thread */ }
    }, Math.max(50, stressConfig.period));
  }
}
async function refreshStress() {
  try {
    const cfg = await fetch('/api/debug/stress', { cache: 'no-store' }).then((r) => r.json());
    if (cfg && (cfg.ms !== stressConfig.ms || cfg.period !== stressConfig.period)) {
      stressConfig = { ms: Number(cfg.ms) || 0, period: Number(cfg.period) || 250 };
      applyStress();
    }
  } catch {}
}
setInterval(refreshStress, 500);
