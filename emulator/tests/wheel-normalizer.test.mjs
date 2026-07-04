import assert from 'node:assert/strict';
import test from 'node:test';

import { createWheelNormalizer } from '../public/wheel-normalizer.mjs';

test('wheel normalizer accumulates small deltas into one relative step', () => {
  const normalizer = createWheelNormalizer({ threshold: 50 });
  assert.equal(normalizer.push(10), 0);
  assert.equal(normalizer.push(15), 0);
  assert.equal(normalizer.push(24), 0);
  assert.equal(normalizer.push(1), -1);
});

test('wheel normalizer clamps large browser deltas to one step', () => {
  const normalizer = createWheelNormalizer({ threshold: 50 });
  assert.equal(normalizer.push(240), -1);
  assert.equal(normalizer.push(1), 0);
  assert.equal(normalizer.push(-240), 1);
  assert.equal(normalizer.push(-1), 0);
});

test('wheel normalizer keeps direction explicit', () => {
  const normalizer = createWheelNormalizer({ threshold: 50 });
  assert.equal(normalizer.push(-50), 1);
  assert.equal(normalizer.push(50), -1);
});
