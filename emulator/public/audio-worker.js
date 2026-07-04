/*
 * Audio producer worker. Runs OFF the main thread so UI rendering can never
 * starve the audio feed. Fetches the live PCM stream and writes 16-bit samples
 * into a SharedArrayBuffer ring that the AudioWorklet consumes directly.
 *
 * Ring protocol (single-producer / single-consumer):
 *   control[0] = writeIndex (monotonic sample count, owned by THIS worker)
 *   control[1] = readIndex  (monotonic sample count, owned by the worklet)
 *   ring[i & MASK]          = interleaved S16 samples (L,R,L,R, ...)
 * The worker only advances writeIndex; the worklet only advances readIndex.
 */

let ring = null;
let control = null;
let mask = 0;
let writeIndex = 0;
let running = false;
let totalWritten = 0;
let totalDropped = 0;

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === 'start') {
    ring = new Int16Array(message.ringSab);
    control = new Int32Array(message.controlSab);
    mask = ring.length - 1;
    writeIndex = Atomics.load(control, 0);
    running = true;
    pump(message.url).catch((error) => {
      self.postMessage({ type: 'error', message: String(error && error.message || error) });
      // brief backoff then retry while still running
      if (running) setTimeout(() => pump(message.url).catch(() => {}), 200);
    });
  } else if (message.type === 'stop') {
    running = false;
  }
};

async function pump(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error('audio stream HTTP ' + response.status);
  const reader = response.body.getReader();
  let carry = -1; // leftover odd byte across chunk boundaries
  let lastReport = 0;

  while (running) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;

    let bytes = value;
    let offset = 0;
    let available = bytes.length;
    // Manual little-endian decode keeps us independent of byte alignment and
    // host endianness.
    let firstSample = null;
    if (carry >= 0) {
      firstSample = (bytes[0] << 8) | carry;
      if (firstSample & 0x8000) firstSample -= 0x10000;
      offset = 1;
      available -= 1;
      carry = -1;
    }
    const pairs = available >> 1;
    if ((available & 1) === 1) carry = bytes[bytes.length - 1];

    const sampleCount = (firstSample !== null ? 1 : 0) + pairs;
    const readIndex = Atomics.load(control, 1);
    let free = ring.length - (writeIndex - readIndex);
    if (free < 0) free = 0;

    let written = 0;
    const writeOne = (sample) => {
      if (written >= free) return false;
      ring[writeIndex & mask] = sample;
      writeIndex += 1;
      written += 1;
      return true;
    };

    if (firstSample !== null) writeOne(firstSample);
    for (let i = 0; i < pairs && written < free; i += 1) {
      const lo = bytes[offset + i * 2];
      const hi = bytes[offset + i * 2 + 1];
      let s = (hi << 8) | lo;
      if (s & 0x8000) s -= 0x10000;
      writeOne(s);
    }

    Atomics.store(control, 0, writeIndex);
    totalWritten += written;
    totalDropped += sampleCount - written; // overflow drops (consumer fell behind)

    const now = Date.now();
    if (now - lastReport > 500) {
      lastReport = now;
      self.postMessage({
        type: 'progress',
        writtenSamples: totalWritten,
        droppedSamples: totalDropped,
        bufferedFrames: (writeIndex - Atomics.load(control, 1)) >> 1,
      });
    }
  }
}
