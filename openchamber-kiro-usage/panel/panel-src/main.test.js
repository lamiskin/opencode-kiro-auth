const { describe, it, expect, beforeEach } = require('bun:test');
const { getColor, validateColorMaps } = require('./colors');

// Mock localStorage for tests
global.localStorage = {
  data: {},
  getItem(key) {
    return this.data[key] || null;
  },
  setItem(key, value) {
    this.data[key] = value;
  },
  clear() {
    this.data = {};
  }
};

describe('Panel Color & State Integration', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('color map namespaces are separate for model and agent', () => {
    const colorMaps = { model: new Map(), agent: new Map() };
    const c1 = getColor('test', 'model', colorMaps);
    const c2 = getColor('test', 'agent', colorMaps);
    // Same key but different namespaces should both get index 0 from palette
    expect(c1).toBe(c2);
    expect(colorMaps.model.size).toBe(1);
    expect(colorMaps.agent.size).toBe(1);
  });

  it('ambiguous and unknown are handled separately with distinct greys', () => {
    const colorMaps = { model: new Map(), agent: new Map() };
    const ambig = getColor('ambiguous', 'agent', colorMaps);
    const unk = getColor('unknown', 'agent', colorMaps);
    expect(ambig).toBe('#d1d5db'); // light grey
    expect(unk).toBe('#9ca3af');   // medium grey
    expect(ambig).not.toBe(unk);
    // Neither should consume a palette slot
    expect(colorMaps.agent.size).toBe(0);
  });

  it('ambiguous does not exist for model split', () => {
    const colorMaps = { model: new Map(), agent: new Map() };
    const c = getColor('ambiguous', 'model', colorMaps);
    // Treated as regular key when split !== agent
    expect(c).toBeTruthy();
    expect(colorMaps.model.size).toBe(1); // consumes slot
  });

  it('persisted color state survives round-trip', () => {
    const original = {
      model: [['gpt-5', 0], ['claude', 1]],
      agent: [['design', 2], ['research', 3]]
    };
    localStorage.setItem('kiro-usage:colors:v1', JSON.stringify(original));
    const stored = localStorage.getItem('kiro-usage:colors:v1');
    const parsed = JSON.parse(stored);
    const validated = validateColorMaps(parsed);

    expect(validated.model.get('gpt-5')).toBe(0);
    expect(validated.model.get('claude')).toBe(1);
    expect(validated.agent.get('design')).toBe(2);
    expect(validated.agent.get('research')).toBe(3);
  });

  it('corrupt persisted state is rejected gracefully', () => {
    localStorage.setItem('kiro-usage:colors:v1', JSON.stringify({
      model: [['valid', 0], ['bad-index', 999]],
      agent: [['bad-type', 'not-number']]
    }));

    const stored = localStorage.getItem('kiro-usage:colors:v1');
    const parsed = JSON.parse(stored);
    const validated = validateColorMaps(parsed);

    expect(validated.model.has('valid')).toBe(true);
    expect(validated.model.has('bad-index')).toBe(false); // out of range
    expect(validated.agent.size).toBe(0); // all entries rejected
  });

  it('palette recycles deterministically after capacity', () => {
    const colorMaps = { model: new Map(), agent: new Map() };
    const colors = [];
    for (let i = 0; i < 15; i++) {
      colors.push(getColor(`key-${i}`, 'model', colorMaps));
    }
    // 10 palette colors should be used (some repeated)
    const unique = new Set(colors);
    expect(unique.size).toBe(10);
  });

  it('all palette colors are distinct', () => {
    const colorMaps = { model: new Map(), agent: new Map() };
    const colors = [];
    for (let i = 0; i < 10; i++) {
      colors.push(getColor(`key-${i}`, 'model', colorMaps));
    }
    const unique = new Set(colors);
    expect(unique.size).toBe(10);
  });
});
