/*
 * PCM playback worklet. Two input paths:
 *
 *  - SAB pull (primary): reads interleaved S16 samples straight from a
 *    SharedArrayBuffer ring filled by audio-worker.js. Nothing on the main
 *    thread is in this path, so UI rendering can never starve playback.
 *  - postMessage push (fallback): used when the page is not cross-origin
 *    isolated (no SharedArrayBuffer). Same resampler, fed by the main thread.
 *
 * In both paths a fractional resampler bridges the 44100 source to the device
 * clock and nudges playback rate to hold the buffer near target. On starvation
 * it holds the last sample (a tiny artifact) instead of re-buffering a gap.
 */
class MovePcmStreamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions || {};
    this.sourceSampleRate = config.sourceSampleRate || 44100;
    this.targetBufferFrames = config.targetBufferFrames || 3072;
    this.maxBufferFrames = config.maxBufferFrames || 6144;
    this.capacityFrames = config.capacityFrames || 65536;

    this.rateStep = this.sourceSampleRate / sampleRate;
    this.currentRateStep = this.rateStep;
    this.readFrac = 0;
    this.started = false;
    this.droppedFrames = 0;
    this.underrunFrames = 0;
    this.processCalls = 0;
    this.lastL = 0;
    this.lastR = 0;

    // SAB pull mode
    this.ring = config.ringSab ? new Int16Array(config.ringSab) : null;
    this.control = config.controlSab ? new Int32Array(config.controlSab) : null;
    this.sabMask = this.ring ? this.ring.length - 1 : 0;
    this.sabRead = 0;          // monotonic sample index (owned here)
    this.sabPrimed = false;

    // push (fallback) mode
    this.left = new Int16Array(this.capacityFrames);
    this.right = new Int16Array(this.capacityFrames);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.bufferedFrames = 0;

    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === 'reset') {
        this.reset();
      } else if (message.type === 'pcm' && message.buffer && !this.ring) {
        this.pushPcm(message.buffer);
      }
    };
  }

  reset() {
    this.started = false;
    this.readFrac = 0;
    this.currentRateStep = this.rateStep;
    this.readIndex = 0;
    this.writeIndex = 0;
    this.bufferedFrames = 0;
    this.sabPrimed = false;
  }

  // ---- rate control shared by both paths ----
  nudgeRate(bufferedFrames) {
    const error = bufferedFrames - this.targetBufferFrames;
    const normalized = Math.max(-1, Math.min(1, error / this.targetBufferFrames));
    const correction = normalized >= 0
      ? normalized * 0.015
      : normalized * 0.003;
    const targetRateStep = this.rateStep * (1 + correction);
    this.currentRateStep += (targetRateStep - this.currentRateStep) * 0.02;
  }

  postStats(bufferedFrames) {
    this.processCalls += 1;
    if (this.processCalls % 128 === 0) {
      this.port.postMessage({
        type: 'stats',
        mode: this.ring ? 'sab' : 'push',
        bufferedFrames,
        droppedFrames: this.droppedFrames,
        underrunFrames: this.underrunFrames,
        sourceSampleRate: this.sourceSampleRate,
        currentRateStep: this.currentRateStep,
      });
    }
  }

  // ---- SAB pull path ----
  processSab(outputLeft, outputRight) {
    const writeIndex = Atomics.load(this.control, 0);
    if (!this.sabPrimed) {
      // Start reading ~target behind the writer to seed the buffer.
      this.sabRead = Math.max(0, writeIndex - this.targetBufferFrames * 2);
      this.sabPrimed = true;
    }

    let buffered = (writeIndex - this.sabRead) >> 1;

    if (!this.started) {
      if (buffered < this.targetBufferFrames) {
        outputLeft.fill(0);
        if (outputRight !== outputLeft) outputRight.fill(0);
        this.postStats(buffered);
        return;
      }
      this.started = true;
    }

    // Hard latency bound.
    if (buffered > this.maxBufferFrames) {
      const drop = buffered - this.targetBufferFrames;
      this.sabRead += drop * 2;
      this.droppedFrames += drop;
      buffered = this.targetBufferFrames;
    }

    const ring = this.ring;
    const mask = this.sabMask;
    for (let index = 0; index < outputLeft.length; index += 1) {
      buffered = (writeIndex - this.sabRead) >> 1;
      if (buffered <= 1) {
        outputLeft[index] = this.lastL;
        outputRight[index] = this.lastR;
        this.underrunFrames += 1;
        continue;
      }
      const frac = this.readFrac;
      const la = ring[this.sabRead & mask] / 32768;
      const ra = ring[(this.sabRead + 1) & mask] / 32768;
      const lb = ring[(this.sabRead + 2) & mask] / 32768;
      const rb = ring[(this.sabRead + 3) & mask] / 32768;
      const l = la + (lb - la) * frac;
      const r = ra + (rb - ra) * frac;
      outputLeft[index] = l;
      outputRight[index] = r;
      this.lastL = l;
      this.lastR = r;

      this.nudgeRate(buffered);
      this.readFrac += this.currentRateStep;
      const consume = Math.floor(this.readFrac);
      this.readFrac -= consume;
      this.sabRead += consume * 2;
    }

    Atomics.store(this.control, 1, this.sabRead);
    this.postStats((writeIndex - this.sabRead) >> 1);
  }

  // ---- push (fallback) path ----
  dropFrames(count) {
    const dropped = Math.min(count, this.bufferedFrames);
    this.readIndex = (this.readIndex + dropped) % this.capacityFrames;
    this.bufferedFrames -= dropped;
    this.droppedFrames += dropped;
  }

  pushPcm(buffer) {
    const pcm = new Int16Array(buffer);
    let frameCount = Math.floor(pcm.length / 2);
    let pcmOffset = 0;
    if (frameCount >= this.capacityFrames) {
      pcmOffset = (frameCount - this.targetBufferFrames) * 2;
      frameCount = this.targetBufferFrames;
      this.reset();
    } else if (this.bufferedFrames + frameCount > this.capacityFrames) {
      this.dropFrames(this.bufferedFrames + frameCount - this.capacityFrames);
    }
    for (let frame = 0; frame < frameCount; frame += 1) {
      this.left[this.writeIndex] = pcm[pcmOffset + frame * 2];
      this.right[this.writeIndex] = pcm[pcmOffset + frame * 2 + 1];
      this.writeIndex = (this.writeIndex + 1) % this.capacityFrames;
      this.bufferedFrames += 1;
    }
  }

  frameAt(offset) {
    const index = (this.readIndex + offset) % this.capacityFrames;
    return [this.left[index] / 32768, this.right[index] / 32768];
  }

  processPush(outputLeft, outputRight) {
    if (!this.started) {
      if (this.bufferedFrames < this.targetBufferFrames) {
        outputLeft.fill(0);
        if (outputRight !== outputLeft) outputRight.fill(0);
        this.postStats(this.bufferedFrames);
        return;
      }
      this.started = true;
    }
    if (this.bufferedFrames > this.maxBufferFrames) {
      this.dropFrames(this.bufferedFrames - this.targetBufferFrames);
    }
    for (let index = 0; index < outputLeft.length; index += 1) {
      if (this.bufferedFrames <= 1) {
        outputLeft[index] = this.lastL;
        outputRight[index] = this.lastR;
        this.underrunFrames += 1;
        continue;
      }
      const frac = this.readFrac;
      const [la, ra] = this.frameAt(0);
      const [lb, rb] = this.frameAt(1);
      const l = la + (lb - la) * frac;
      const r = ra + (rb - ra) * frac;
      outputLeft[index] = l;
      outputRight[index] = r;
      this.lastL = l;
      this.lastR = r;
      this.nudgeRate(this.bufferedFrames);
      this.readFrac += this.currentRateStep;
      const consume = Math.floor(this.readFrac);
      this.readFrac -= consume;
      if (consume > 0) {
        const c = Math.min(consume, this.bufferedFrames);
        this.readIndex = (this.readIndex + c) % this.capacityFrames;
        this.bufferedFrames -= c;
      }
    }
    this.postStats(this.bufferedFrames);
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const outputLeft = output[0];
    const outputRight = output[1] || outputLeft;
    if (this.ring) this.processSab(outputLeft, outputRight);
    else this.processPush(outputLeft, outputRight);
    return true;
  }
}

registerProcessor('move-pcm-stream', MovePcmStreamProcessor);
