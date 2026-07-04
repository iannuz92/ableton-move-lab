import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stepViewKey, setStepOverride, reconcileOverlay, applyStepOverlay } from '../public/step-led-overlay.mjs';

function assertOverride(value, lit) {
  assert.equal(value?.lit, lit);
  assert.equal(typeof value?.at, 'number');
}

describe('stepViewKey', () => {
  it('includes track, pad, bar', () => {
    assert.equal(stepViewKey({ trackIndex: 0, padIndex: 3, barIndex: 1 }), '0:3:1');
  });

  it('uses * for null padIndex', () => {
    assert.equal(stepViewKey({ trackIndex: 2, padIndex: null, barIndex: 0 }), '2:*:0');
  });

  it('distinguishes different views', () => {
    assert.notEqual(
      stepViewKey({ trackIndex: 0, padIndex: null, barIndex: 0 }),
      stepViewKey({ trackIndex: 0, padIndex: null, barIndex: 1 }),
    );
    assert.notEqual(
      stepViewKey({ trackIndex: 0, padIndex: 5, barIndex: 0 }),
      stepViewKey({ trackIndex: 1, padIndex: 5, barIndex: 0 }),
    );
  });
});

describe('setStepOverride', () => {
  it('stores override for a step', () => {
    const overlay = new Map();
    const view = { trackIndex: 0, padIndex: null, barIndex: 0 };
    setStepOverride(overlay, view, 3, true);
    setStepOverride(overlay, view, 7, false);
    const overrides = overlay.get('0:*:0');
    assert.ok(overrides);
    assertOverride(overrides.get(3), true);
    assertOverride(overrides.get(7), false);
    assert.equal(overrides.size, 2);
  });

  it('overwrites existing override', () => {
    const overlay = new Map();
    const view = { trackIndex: 0, padIndex: null, barIndex: 0 };
    setStepOverride(overlay, view, 3, false);
    setStepOverride(overlay, view, 3, true);
    assertOverride(overlay.get('0:*:0').get(3), true);
  });

  it('scopes by view key', () => {
    const overlay = new Map();
    setStepOverride(overlay, { trackIndex: 0, padIndex: null, barIndex: 0 }, 3, true);
    setStepOverride(overlay, { trackIndex: 0, padIndex: 5, barIndex: 0 }, 3, false);
    assertOverride(overlay.get('0:*:0').get(3), true);
    assertOverride(overlay.get('0:5:0').get(3), false);
  });
});

describe('reconcileOverlay', () => {
  it('removes override that matches base state', () => {
    const overlay = new Map();
    const view = { trackIndex: 0, padIndex: null, barIndex: 0 };
    const base = new Set([3, 7]);
    setStepOverride(overlay, view, 3, true); // base has 3 lit, override says lit → match
    setStepOverride(overlay, view, 5, false); // base doesn't have 5, override says off → match
    setStepOverride(overlay, view, 7, false); // base has 7 lit, override says off → differs
    reconcileOverlay(overlay, view, base);
    const overrides = overlay.get('0:*:0');
    assert.ok(overrides);
    assert.equal(overrides.size, 1);
    assertOverride(overrides.get(7), false);
  });

  it('removes key when all overrides reconciled', () => {
    const overlay = new Map();
    const view = { trackIndex: 0, padIndex: null, barIndex: 0 };
    const base = new Set([3]);
    setStepOverride(overlay, view, 3, true);
    reconcileOverlay(overlay, view, base);
    assert.equal(overlay.has('0:*:0'), false);
  });

  it('noops for missing view', () => {
    const overlay = new Map();
    reconcileOverlay(overlay, { trackIndex: 9, padIndex: null, barIndex: 0 }, new Set());
    // should not throw
  });
});

describe('applyStepOverlay', () => {
  it('returns base unchanged when no overlay exists', () => {
    const overlay = new Map();
    const base = new Set([1, 2, 3]);
    const view = { trackIndex: 0, padIndex: null, barIndex: 0 };
    const result = applyStepOverlay(base, overlay, view);
    assert.deepEqual([...result].sort(), [1, 2, 3]);
    assert.notStrictEqual(result, base); // defensive copy
  });

  it('forces step on via overlay', () => {
    const overlay = new Map();
    const view = { trackIndex: 0, padIndex: null, barIndex: 0 };
    const base = new Set([1]);
    setStepOverride(overlay, view, 5, true);
    const result = applyStepOverlay(base, overlay, view);
    assert.deepEqual([...result].sort(), [1, 5]);
  });

  it('forces step off via overlay', () => {
    const overlay = new Map();
    const view = { trackIndex: 0, padIndex: null, barIndex: 0 };
    const base = new Set([1, 5, 8]);
    setStepOverride(overlay, view, 5, false);
    const result = applyStepOverlay(base, overlay, view);
    assert.deepEqual([...result].sort(), [1, 8]);
  });

  it('combines multiple overrides', () => {
    const overlay = new Map();
    const view = { trackIndex: 0, padIndex: null, barIndex: 0 };
    const base = new Set([0, 2, 4, 6]);
    setStepOverride(overlay, view, 0, false); // remove 0
    setStepOverride(overlay, view, 3, true);  // add 3
    setStepOverride(overlay, view, 6, false); // remove 6
    const result = applyStepOverlay(base, overlay, view);
    assert.deepEqual([...result].sort(), [2, 3, 4]);
  });

  it('scopes by view', () => {
    const overlay = new Map();
    const base = new Set([1, 2]);
    setStepOverride(overlay, { trackIndex: 0, padIndex: null, barIndex: 0 }, 1, false);
    setStepOverride(overlay, { trackIndex: 1, padIndex: null, barIndex: 0 }, 2, false);
    const r0 = applyStepOverlay(base, overlay, { trackIndex: 0, padIndex: null, barIndex: 0 });
    const r1 = applyStepOverlay(base, overlay, { trackIndex: 1, padIndex: null, barIndex: 0 });
    assert.deepEqual([...r0].sort(), [2]);
    assert.deepEqual([...r1].sort(), [1]);
  });
});

describe('end-to-end: optimistic toggle lifecycle', () => {
  it('toggle on, base catches up, overlay reconciles', () => {
    const overlay = new Map();
    const view = { trackIndex: 0, padIndex: null, barIndex: 0 };

    // Initial: base has no steps
    let base = new Set();
    const lit1 = applyStepOverlay(base, overlay, view);
    assert.deepEqual([...lit1].sort(), []);

    // User clicks step 3 → toggle ON
    setStepOverride(overlay, view, 3, true);
    const lit2 = applyStepOverlay(base, overlay, view);
    assert.deepEqual([...lit2].sort(), [3]);

    // Engine writes step 3 to Song.abl → base catches up
    base = new Set([3]);
    reconcileOverlay(overlay, view, base);
    const lit3 = applyStepOverlay(base, overlay, view);
    assert.deepEqual([...lit3].sort(), [3]);
    assert.equal(overlay.has('0:*:0'), false); // overlay cleaned
  });

  it('toggle off, base catches up, overlay reconciles', () => {
    const overlay = new Map();
    const view = { trackIndex: 0, padIndex: null, barIndex: 0 };

    // Initial: base has step 5 lit
    let base = new Set([5]);
    const lit1 = applyStepOverlay(base, overlay, view);
    assert.deepEqual([...lit1].sort(), [5]);

    // User clicks step 5 → toggle OFF
    setStepOverride(overlay, view, 5, false);
    const lit2 = applyStepOverlay(base, overlay, view);
    assert.deepEqual([...lit2].sort(), []);

    // Engine removes step 5 from Song.abl
    base = new Set();
    reconcileOverlay(overlay, view, base);
    const lit3 = applyStepOverlay(base, overlay, view);
    assert.deepEqual([...lit3].sort(), []);
    assert.equal(overlay.has('0:*:0'), false);
  });
});
