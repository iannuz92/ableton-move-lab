export function stepViewKey({ trackIndex, padIndex, barIndex }) {
  return `${trackIndex}:${padIndex ?? '*'}:${barIndex}`;
}

const DEFAULT_MAX_AGE_MS = 5000;

function normalizeOverride(override) {
  if (override && typeof override === 'object') return override;
  return { lit: !!override, at: 0 };
}

export function setStepOverride(overlay, view, stepIndex, lit) {
  const key = stepViewKey(view);
  let overrides = overlay.get(key);
  if (!overrides) {
    overrides = new Map();
    overlay.set(key, overrides);
  }
  overrides.set(stepIndex, { lit, at: Date.now() });
}

export function reconcileOverlay(overlay, view, baseLitSteps, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const key = stepViewKey(view);
  const overrides = overlay.get(key);
  if (!overrides) return;
  for (const [si, rawOverride] of overrides) {
    const override = normalizeOverride(rawOverride);
    if (override.lit === baseLitSteps.has(si) || (override.at && now - override.at > maxAgeMs)) {
      overrides.delete(si);
    }
  }
  if (overrides.size === 0) overlay.delete(key);
}

export function applyStepOverlay(baseLitSteps, overlay, view, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const key = stepViewKey(view);
  const overrides = overlay.get(key);
  const result = new Set(baseLitSteps);
  if (!overrides || overrides.size === 0) return result;
  for (const [si, rawOverride] of overrides) {
    const override = normalizeOverride(rawOverride);
    if (override.at && now - override.at > maxAgeMs) continue;
    if (override.lit) result.add(si);
    else result.delete(si);
  }
  return result;
}
