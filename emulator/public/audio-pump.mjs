// Audio scheduling decoupled from fetch/decode.
// Pump.push(buf) accumulates AudioBuffers; processTicks() consumes the queue
// contiguously without hard-resetting nextStartTime. The timeline stays
// continuous: the duration cap drops from the front (audio gap = one buffer,
// but time is preserved).

export function createAudioPump(audioCtx, opts = {}) {
  const targetLead = opts.targetLead ?? 0.04;
  const minLead = opts.minLead ?? 0.005;
  const maxLead = opts.maxLead ?? 0.20;
  let queue = [];
  let nextStartTime = -1;
  let running = false;
  let timer = null;

  function processTicks() {
    if (!running) return;
    const now = audioCtx.currentTime;
    // Duration queue cap: if it exceeds maxLead, drop from the front for low latency.
    let queuedDuration = 0;
    for (const b of queue) queuedDuration += b.duration;
    while (queue.length > 0 && queuedDuration - maxLead > 1e-9) {
      queuedDuration -= queue[0].duration;
      queue.shift();
    }
    // Prime: first schedule anchored to now + targetLead.
    if (nextStartTime < 0) {
      if (queue.length === 0) return;
      nextStartTime = now + targetLead;
    }
    // Clamp: if we slipped behind realtime after the queue ran dry, reattach to now + minLead.
    if (nextStartTime < now + minLead) {
      nextStartTime = now + minLead;
    }
    // Schedule all buffers within the maxLead budget.
    while (queue.length > 0) {
      const startTime = nextStartTime;
      if (startTime - now > maxLead) break;
      const buf = queue.shift();
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      src.start(startTime);
      nextStartTime = startTime + buf.duration;
    }
  }

  function tick() {
    processTicks();
    if (running) timer = setTimeout(tick, 5);
    else timer = null;
  }

  return {
    start() {
      running = true;
      queue = [];
      nextStartTime = -1;
      timer = null;
      tick();
    },
    stop() {
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      queue = [];
      nextStartTime = -1;
    },
    push(buf) {
      queue.push(buf);
      if (running && !timer) tick();
    },
    processTicks,
    get queueLength() { return queue.length; },
    get nextStartTime() { return nextStartTime; },
    get running() { return running; },
  };
}
