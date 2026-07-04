// Scheduling audio disaccoppiato dal fetch/decode.
// Pump.push(buf) accumula AudioBuffer; processTicks() consuma la coda in modo
// contiguo senza hard-reset di nextStartTime. La timeline resta continua: la
// cap per duration droppa il front (gap audio = un buffer, ma tempo preservato).

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
    // Cap coda per duration: se supera maxLead, droppiamo front per latenza bassa
    let queuedDuration = 0;
    for (const b of queue) queuedDuration += b.duration;
    while (queue.length > 0 && queuedDuration - maxLead > 1e-9) {
      queuedDuration -= queue[0].duration;
      queue.shift();
    }
    // Prime: prima schedulazione ancorata a now + targetLead
    if (nextStartTime < 0) {
      if (queue.length === 0) return;
      nextStartTime = now + targetLead;
    }
    // Clamp: se scivolati dietro realtime (coda prosciugata), riaggancia a now + minLead
    if (nextStartTime < now + minLead) {
      nextStartTime = now + minLead;
    }
    // Schedule tutti i buffer entro il budget maxLead
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