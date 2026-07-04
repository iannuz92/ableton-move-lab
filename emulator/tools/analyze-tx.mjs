import { open } from 'node:fs/promises';

const SPI_HEADER_SIZE = 24;
const TX_MIDI_REGION = 0x50;
const PATH = 'emulator/spi/tx-packets.bin';

const allSysExHeaders = new Map();
const allCcValues = new Map();
const allNoteOns = new Set();
let totalFrames = 0;
let totalSysEx = 0;
let totalCc = 0;

const handle = await open(PATH, 'r');
const { size } = await handle.stat();

const chunkSize = 1024 * 1024; // 1MB chunks
for (let offset = 0; offset < size;) {
  const want = Math.min(chunkSize, size - offset);
  const buffer = Buffer.alloc(want);
  await handle.read(buffer, 0, want, offset);

  let pos = 0;
  while (pos + SPI_HEADER_SIZE <= buffer.length) {
    const dataLen = buffer.readUInt32LE(pos + 16);
    const recEnd = pos + SPI_HEADER_SIZE + dataLen;
    if (dataLen <= 0 || recEnd > buffer.length) break;
    totalFrames += 1;

    const region = buffer.subarray(pos + SPI_HEADER_SIZE, pos + SPI_HEADER_SIZE + TX_MIDI_REGION);

    // Parse USB-MIDI packets (4 bytes each)
    const rawData = [];
    for (let j = 0; j + 4 <= TX_MIDI_REGION; j += 4) {
      const cin = region[j] & 0x0f;
      const b1 = region[j + 1], b2 = region[j + 2], b3 = region[j + 3];

      if (cin === 0x0b && (b1 & 0xf0) === 0xb0) {
        // Control Change
        totalCc += 1;
        const prev = allCcValues.get(b2);
        if (prev === undefined) {
          allCcValues.set(b2, new Set([b3]));
        } else {
          prev.add(b3);
        }
      } else if (cin === 0x09 && (b1 & 0xf0) === 0x90 && b3 > 0) {
        // Note On (velocity > 0)
        allNoteOns.add(b2);
      } else if (cin === 0x04 || cin === 0x07) {
        rawData.push(b1, b2, b3);
      } else if (cin === 0x06) {
        rawData.push(b1, b2);
      } else if (cin === 0x05) {
        rawData.push(b1);
      }
    }

    // Extract SysEx headers from reassembled data
    let i = 0;
    while (i < rawData.length) {
      if (rawData[i] !== 0xf0) { i += 1; continue; }
      let k = i + 1;
      while (k < rawData.length && rawData[k] !== 0xf7) k += 1;
      if (k >= rawData.length) break;
      const sx = rawData.slice(i, k + 1);
      const headerKey = sx.slice(0, Math.min(12, sx.length)).join(',');
      const count = allSysExHeaders.get(headerKey) || 0;
      allSysExHeaders.set(headerKey, count + 1);
      totalSysEx += 1;
      i = k + 1;
    }

    pos = recEnd;
  }

  offset += want;
  if (totalFrames % 50000 === 0) process.stderr.write(`\rFrames: ${totalFrames}  SysEx: ${totalSysEx}  CCs: ${totalCc}`);
}

await handle.close();
console.log(`\n\nTotal frames: ${totalFrames}`);
console.log(`Total SysEx messages: ${totalSysEx}`);
console.log(`Total CC messages: ${totalCc}\n`);

console.log('=== UNIQUE SysEx HEADERS (first 12 bytes) ===');
const sortedSysEx = [...allSysExHeaders.entries()].sort((a, b) => b[1] - a[1]);
for (const [header, count] of sortedSysEx.slice(0, 30)) {
  const bytes = header.split(',').map(n => parseInt(n));
  const hex = bytes.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
  console.log(`  [${hex}]  count=${count}`);
}

console.log('\n=== CC values by CC number ===');
for (const cc of [...allCcValues.keys()].sort((a, b) => a - b)) {
  const values = [...allCcValues.get(cc)].sort((a, b) => a - b);
  console.log(`  CC 0x${cc.toString(16).padStart(2, '0')} (${cc}): values=[${values.join(',')}]`);
}

console.log('\n=== Note On messages seen ===');
for (const note of [...allNoteOns].sort((a, b) => a - b)) {
  console.log(`  Note 0x${note.toString(16).padStart(2, '0')} (${note})`);
}
