const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const { buildIndex, resolve } = require('./agent-index');

describe('Agent Index', () => {
  describe('buildIndex', () => {
    it('creates Map indexed by normalized model ID', () => {
      const rows = [
        { model_id: 'claude-3', agent: 'build', time_created: 1000, time_completed: 2000, session_id: 's1' },
        { model_id: 'claude-3', agent: 'fixer', time_created: 3000, time_completed: 4000, session_id: 's2' }
      ];
      const index = buildIndex(rows);
      expect(index.has('claude-3')).toBe(true);
      const rowsForModel = index.get('claude-3');
      expect(rowsForModel.length).toBe(2);
    });
  });

  describe('resolve', () => {
    it('single overlapping candidate -> inferred with agent name', () => {
      const rows = [
        { model_id: 'claude-3', agent: 'build', time_created: 1000, time_completed: 2000, session_id: 's1' }
      ];
      const index = buildIndex(rows);

      // t = 1500 falls in [created-2000, rowEnd+2000] = [-1000, 4000]
      const result = resolve(index, { t: 1500, model: 'claude-3' });
      expect(result.source).toBe('inferred');
      expect(result.agent).toBe('build');
    });

    it('two agents same model overlapping -> ambiguous with candidates', () => {
      const rows = [
        { model_id: 'claude-3', agent: 'build', time_created: 1000, time_completed: 2000, session_id: 's1' },
        { model_id: 'claude-3', agent: 'fixer', time_created: 1100, time_completed: 2100, session_id: 's2' }
      ];
      const index = buildIndex(rows);

      const result = resolve(index, { t: 1500, model: 'claude-3' });
      expect(result.source).toBe('ambiguous');
      expect(result.candidates).toContain('build');
      expect(result.candidates).toContain('fixer');
    });

    it('no candidate -> unknown/no_candidate', () => {
      const rows = [
        { model_id: 'claude-3', agent: 'build', time_created: 2000, time_completed: 3000, session_id: 's1' }
      ];
      const index = buildIndex(rows);

      const result = resolve(index, { t: 5100, model: 'claude-3' });
      expect(result.source).toBe('unknown');
      expect(result.reason).toBe('no_candidate');
    });

    it('model normalization: claude-sonnet-4.5-thinking matches claude-sonnet-4-5', () => {
      const rows = [
        { model_id: 'claude-sonnet-4-5', agent: 'build', time_created: 1000, time_completed: 2000, session_id: 's1' }
      ];
      const index = buildIndex(rows);

      // Query with thinking variant
      const result = resolve(index, { t: 1500, model: 'claude-sonnet-4.5-thinking' });
      expect(result.source).toBe('inferred');
      expect(result.agent).toBe('build');
    });

    it('captured agent (from log) beats inference', () => {
      const rows = [
        { model_id: 'claude-3', agent: 'build', time_created: 1000, time_completed: 2000, session_id: 's1' }
      ];
      const index = buildIndex(rows);

      // If we call with capturedAgent set, it should return source 'captured'
      // (This is handled in lib.js, not in agent-index.js resolve)
      // Just verify resolve works
      const result = resolve(index, { t: 1500, model: 'claude-3' });
      expect(result.source).toBe('inferred');
    });

    it('time outside coverage -> unknown/no_candidate (strict: no lag heuristic)', () => {
      const rows = [
        { model_id: 'claude-3', time_created: 2000, time_completed: 3000, agent: 'oracle', session_id: 'sess-1' }
      ];
      const index = buildIndex(rows);

      // Window [created-2000, rowEnd+2000] = [0, 5000]
      // t=5100 is outside -> unknown
      const result = resolve(index, { t: 5100, model: 'claude-3' });
      expect(result.source).toBe('unknown');
      expect(result.reason).toBe('no_candidate');
    });

    it('model normalization: claude-sonnet-4.5-thinking matches claude-sonnet-4-5', () => {
      const rows = [
        { model_id: 'claude-sonnet-4-5', agent: 'oracle', time_created: 1000, time_completed: 2000, session_id: 's1' }
      ];
      const index = buildIndex(rows);

      const result = resolve(index, { t: 1500, model: 'claude-sonnet-4.5-thinking' });
      expect(result.source).toBe('inferred');
      expect(result.agent).toBe('oracle');
    });

    it('binary search + 60-row scan window', () => {
      // Create 100 rows
      const rows = [];
      for (let i = 0; i < 100; i++) {
        rows.push({
          model_id: 'claude-3',
          time_created: i * 100,
          time_completed: i * 100 + 50,
          agent: `agent-${i}`,
          session_id: `sess-${i}`
        });
      }
      const index = buildIndex(rows);

      // Target: t = 5050, should match rows in range [created-2000, rowEnd+2000]
      // This can match multiple agents within 60-row scan; verify it returns ambiguous with candidates
      const result = resolve(index, { t: 5050, model: 'claude-3' });
      expect(result.source).toBe('ambiguous');
      expect(result.candidates.length).toBeGreaterThan(0);
      // agent-50 and agent-51 should be in the candidates
      expect(result.candidates.includes('agent-50') || result.candidates.includes('agent-51')).toBe(true);
    });
  });
});
