import { test } from 'node:test';
import assert from 'node:assert/strict';
import { padIdForIndex, summarize, DOCUMENTED_INDICES } from '../tools/scan-led-palette.mjs';

test('padIdForIndex maps the GUI grid to Move pad notes (top-left 0x5C)', () => {
  assert.equal(padIdForIndex(0), 0x5c);   // top-left
  assert.equal(padIdForIndex(7), 0x63);   // top-right
  assert.equal(padIdForIndex(24), 0x44);  // bottom-left
  assert.equal(padIdForIndex(31), 0x4b);  // bottom-right
});

test('summarize sorts by index and flags documented vs faked colours', () => {
  const catalog = new Map([
    [0x17, { index: 0x17, count: 2, contexts: new Set(['session', 'session:left']) }],
    [0x7f, { index: 0x7f, count: 1, contexts: new Set(['note:track1']) }],
    [0x00, { index: 0x00, count: 5, contexts: new Set(['session']) }],
  ]);
  const rows = summarize(catalog);
  assert.deepEqual(rows.map((r) => r.index), [0x00, 0x17, 0x7f]);

  const clip = rows.find((r) => r.index === 0x17);
  assert.equal(clip.hex, '0x17');
  assert.equal(clip.documented, false); // Session clip colour is not calibrated
  assert.deepEqual(clip.contexts, ['session', 'session:left']); // sorted, deduped

  assert.equal(rows.find((r) => r.index === 0x7f).documented, true); // red is real
});

test('DOCUMENTED_INDICES matches the chart-known colours plus off/dim', () => {
  for (const known of [0x00, 0x03, 0x7f, 0x4f, 0x7e, 0x5f, 0x7d, 0x6f, 0x78]) {
    assert.ok(DOCUMENTED_INDICES.has(known), `expected ${known.toString(16)} documented`);
  }
  // Session clip colour indices observed on the live engine are NOT documented.
  assert.equal(DOCUMENTED_INDICES.has(0x12), false);
  assert.equal(DOCUMENTED_INDICES.has(0x17), false);
});
