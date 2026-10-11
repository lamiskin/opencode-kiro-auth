const { describe, it, expect } = require('bun:test');
const { getColor, validateColorMaps } = require('./colors');

describe('Color Assignment', () => {
  it('assigns distinct colors to 10 distinct keys (palette size)', () => {
    const colorMaps = { model: new Map(), agent: new Map() };
    const keys = Array.from({ length: 10 }, (_, i) => `key-${i}`);
    const colors = keys.map(k => getColor(k, 'model', colorMaps));
    const unique = new Set(colors);
    expect(unique.size).toBe(10);
  });

  it('wraps palette when > 10 keys assigned', () => {
    const colorMaps = { model: new Map(), agent: new Map() };
    const keys = Array.from({ length: 12 }, (_, i) => `key-${i}`);
    const colors = keys.map(k => getColor(k, 'model', colorMaps));
    // Should have 10 unique palette colors (some reused)
    const unique = new Set(colors);
    expect(unique.size).toBe(10);
  });

  it('assigns same color to same key across calls', () => {
    const colorMaps = { model: new Map(), agent: new Map() };
    const c1 = getColor('test-key', 'model', colorMaps);
    const c2 = getColor('test-key', 'model', colorMaps);
    expect(c1).toBe(c2);
  });

  it('model and agent namespaces are independent', () => {
    const colorMaps = { model: new Map(), agent: new Map() };
    const modelColor = getColor('shared-key', 'model', colorMaps);
    const agentColor = getColor('shared-key', 'agent', colorMaps);
    expect(modelColor).toBe(agentColor); // both get index 0, different namespaces
    expect(colorMaps.model.size).toBe(1);
    expect(colorMaps.agent.size).toBe(1);
  });

  it('ambiguous returns neutral grey for agent split', () => {
    const colorMaps = { model: new Map(), agent: new Map() };
    const color = getColor('ambiguous', 'agent', colorMaps);
    expect(color).toBe('#d1d5db');
    expect(colorMaps.agent.size).toBe(0); // does not consume a slot
  });

  it('unknown returns different grey for agent split', () => {
    const colorMaps = { model: new Map(), agent: new Map() };
    const color = getColor('unknown', 'agent', colorMaps);
    expect(color).toBe('#9ca3af');
    expect(colorMaps.agent.size).toBe(0);
  });

  it('ambiguous and unknown are visually distinct', () => {
    const ambig = '#d1d5db';
    const unk = '#9ca3af';
    expect(ambig).not.toBe(unk);
  });

  it('validateColorMaps accepts valid persisted state', () => {
    const stored = {
      model: [['model-a', 0], ['model-b', 1]],
      agent: [['agent-x', 0]]
    };
    const result = validateColorMaps(stored);
    expect(result.model.get('model-a')).toBe(0);
    expect(result.model.get('model-b')).toBe(1);
    expect(result.agent.get('agent-x')).toBe(0);
  });

  it('validateColorMaps rejects out-of-range indices', () => {
    const stored = {
      model: [['valid', 0], ['invalid', 999]],
      agent: []
    };
    const result = validateColorMaps(stored);
    expect(result.model.has('valid')).toBe(true);
    expect(result.model.has('invalid')).toBe(false);
  });

  it('validateColorMaps rejects non-numeric values', () => {
    const stored = {
      model: [['bad', 'not-a-number']],
      agent: []
    };
    const result = validateColorMaps(stored);
    expect(result.model.size).toBe(0);
  });

  it('validateColorMaps skips collision on second occurrence', () => {
    const stored = {
      model: [['first', 0], ['second', 0], ['third', 1]],
      agent: []
    };
    const result = validateColorMaps(stored);
    expect(result.model.size).toBe(2);
    expect(result.model.has('first')).toBe(true);
    expect(result.model.has('third')).toBe(true);
    expect(result.model.has('second')).toBe(false);
  });

  it('validateColorMaps returns empty on null/undefined', () => {
    const r1 = validateColorMaps(null);
    const r2 = validateColorMaps(undefined);
    expect(r1.model.size).toBe(0);
    expect(r2.agent.size).toBe(0);
  });
});
