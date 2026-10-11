// Color assignment for Kiro usage panel
// Deterministic, collision-free, separate namespaces for model vs agent

const PALETTE = [
  '#6366f1',
  '#8b5cf6',
  '#d946ef',
  '#ec4899',
  '#f43f5e',
  '#fb7185',
  '#fbbf24',
  '#10b981',
  '#14b8a6',
  '#06b6d4'
];

const AMBIGUOUS_COLOR = '#d1d5db'; // light grey
const UNKNOWN_COLOR = '#9ca3af';   // medium grey

function getColor(key, split, colorMaps) {
  if (split === 'agent') {
    if (key === 'ambiguous') return AMBIGUOUS_COLOR;
    if (key === 'unknown') return UNKNOWN_COLOR;
  }

  const ns = split === 'agent' ? 'agent' : 'model';
  if (!colorMaps[ns]) colorMaps[ns] = new Map();

  const nsMap = colorMaps[ns];
  if (!nsMap.has(key)) {
    const usedIndices = new Set(nsMap.values());
    let idx = 0;
    while (usedIndices.has(idx) && idx < PALETTE.length) idx++;
    if (idx >= PALETTE.length) idx = usedIndices.size % PALETTE.length;
    nsMap.set(key, idx);
  }

  const idx = nsMap.get(key);
  return PALETTE[idx] || '#ccc';
}

function validateColorMaps(stored) {
  const result = { model: new Map(), agent: new Map() };
  if (!stored || typeof stored !== 'object') return result;

  const VALID_RANGE = PALETTE.length;
  for (const ns of ['model', 'agent']) {
    if (!Array.isArray(stored[ns])) continue;

    const seen = new Set();
    for (const [k, v] of stored[ns]) {
      if (typeof v !== 'number' || v < 0 || v >= VALID_RANGE) continue;
      if (seen.has(v)) continue; // skip collisions
      seen.add(v);
      result[ns].set(k, v);
    }
  }
  return result;
}

export { getColor, validateColorMaps };
