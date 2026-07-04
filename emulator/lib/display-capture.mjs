export const SPI_RECORD_HEADER_SIZE = 24;
export const DISPLAY_PACKET_SIZE = 0x300;
export const SPI_RECORD_SIZE = SPI_RECORD_HEADER_SIZE + DISPLAY_PACKET_SIZE;

export function parseDisplayCapture(buffer, fileSize = buffer.length) {
  const streams = new Map();
  let frame = null;
  let selectedSource = 0;
  let completeFrames = 0;
  let packetCount = 0;
  let lastSequence = 0;
  let lastRequest = 0;

  for (let offset = 0; offset + SPI_RECORD_HEADER_SIZE <= buffer.length;) {
    const sequence = Number(buffer.readBigUInt64LE(offset));
    const length = buffer.readUInt32LE(offset + 16);
    const source = buffer.readUInt32LE(offset + 20);
    const dataStart = offset + SPI_RECORD_HEADER_SIZE;
    const dataEnd = dataStart + length;
    if (length <= 0 || dataEnd > buffer.length) break;

    const packet = buffer.subarray(dataStart, dataEnd);
    packetCount += 1;

    if (packet.length >= 0x54) {
      const request = packet.readUInt32LE(0x50);
      if (request >= 1 && request <= 6) {
        const stream = streams.get(source) || { chunks: [], nextRequest: 1 };
        const frameOffset = (request - 1) * 0xac;
        const chunkLength = Math.min(0xac, 0x400 - frameOffset);
        if (packet.length >= 0x54 + chunkLength) {
          const chunk = Buffer.from(packet.subarray(0x54, 0x54 + chunkLength));

          if (request === 1) {
            stream.chunks = [chunk];
            stream.nextRequest = 2;
          } else if (request === stream.nextRequest) {
            stream.chunks.push(chunk);
            stream.nextRequest += 1;
          } else {
            stream.chunks = [];
            stream.nextRequest = 1;
          }

          if (request === 6 && stream.chunks.length === 6) {
            const completedFrame = Buffer.concat(stream.chunks, 0x400);
            const hasPixels = completedFrame.some((byte) => byte !== 0);
            /*
             * Move and MoveControlModeHandler share the SPI capture. The
             * control-mode process continuously emits blank display cycles;
             * do not let those newer blank frames hide the engine framebuffer.
             */
            if (hasPixels || !frame) {
              frame = completedFrame;
              selectedSource = source;
              lastSequence = sequence;
              lastRequest = request;
            }
            completeFrames += 1;
            stream.chunks = [];
            stream.nextRequest = 1;
          }
          streams.set(source, stream);
        }
      }
    }

    offset = dataEnd;
  }

  if (!frame) {
    return {
      available: false,
      width: 128,
      height: 64,
      txBytes: fileSize,
      packetCount,
      completeFrames,
    };
  }

  return {
    available: true,
    width: 128,
    height: 64,
    format: 'ssd1306-1bpp-pages',
    framebuffer: frame.toString('base64'),
    txBytes: fileSize,
    packetCount,
    completeFrames,
    lastSequence,
    lastRequest,
    source: selectedSource,
  };
}
