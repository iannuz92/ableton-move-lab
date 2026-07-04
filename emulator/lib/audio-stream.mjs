export const PCM_FRAME_BYTES = 4;

export function alignPcmByteLength(byteLength) {
  return byteLength - (byteLength % PCM_FRAME_BYTES);
}

export function appendBytes(left, right) {
  if (!left || left.length === 0) return right;
  if (!right || right.length === 0) return left;
  const merged = Buffer.allocUnsafe(left.length + right.length);
  left.copy(merged, 0);
  right.copy(merged, left.length);
  return merged;
}

export function takeChunk(buffer, minimumBytes, maximumBytes) {
  const wanted = Math.min(buffer.length, maximumBytes);
  const alignedWanted = alignPcmByteLength(wanted);
  if (alignedWanted <= 0) return { chunk: null, remaining: buffer };
  if (alignedWanted < minimumBytes && buffer.length < maximumBytes) {
    return { chunk: null, remaining: buffer };
  }
  return {
    chunk: buffer.subarray(0, alignedWanted),
    remaining: buffer.subarray(alignedWanted),
  };
}

export function createRealtimePacer({
  bytesPerSecond,
  initialCreditBytes = 0,
  now = () => Date.now(),
}) {
  const startedAt = now();
  let sentBytes = 0;
  return {
    availableBytes() {
      const elapsedSeconds = Math.max(0, now() - startedAt) / 1000;
      const budget = initialCreditBytes + elapsedSeconds * bytesPerSecond - sentBytes;
      return alignPcmByteLength(Math.max(0, Math.floor(budget)));
    },
    consume(byteLength) {
      sentBytes += alignPcmByteLength(byteLength);
    },
    get sentBytes() {
      return sentBytes;
    },
  };
}
