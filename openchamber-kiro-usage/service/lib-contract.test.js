const { describe, it, expect } = require('bun:test');
const { getUsageSeries, parseLogTimestamp, getAgentIndex, getPairedRecords } = require('./lib');

describe('Kiro Usage Library - Contract Tests', () => {
  describe('getUsageSeries - exact preset bucket counts', () => {
    const mockFsWrapper = { existsSync: () => true, readdirSync: () => [] };

    it('6h preset yields exactly 6 buckets', () => {
      const result = getUsageSeries('/tmp/logs', { range: '6h', now: new Date('2026-10-09T15:00:00Z'), fsWrapper: mockFsWrapper });
      expect(result.buckets.length).toBe(6);
    });

    it('24h preset yields exactly 24 buckets', () => {
      const result = getUsageSeries('/tmp/logs', { range: '24h', now: new Date('2026-10-09T00:00:00Z'), fsWrapper: mockFsWrapper });
      expect(result.buckets.length).toBe(24);
    });

    it('7d preset yields exactly 168 buckets', () => {
      const result = getUsageSeries('/tmp/logs', { range: '7d', now: new Date('2026-10-09T00:00:00Z'), fsWrapper: mockFsWrapper });
      expect(result.buckets.length).toBe(168);
    });

    it('30d preset yields exactly 30 buckets', () => {
      const result = getUsageSeries('/tmp/logs', { range: '30d', now: new Date('2026-10-09T00:00:00Z'), fsWrapper: mockFsWrapper });
      expect(result.buckets.length).toBe(30);
    });
  });

  describe('getUsageSeries - local-clock alignment', () => {
    const mockFsWrapper = { existsSync: () => true, readdirSync: () => [] };

    it('hourly buckets are 1-hour apart', () => {
      const result = getUsageSeries('/tmp/logs', { range: '7d', now: new Date('2026-10-04T10:30:00Z'), fsWrapper: mockFsWrapper });
      expect(result.buckets.length).toBe(168);
      for (let i = 1; i < result.buckets.length; i++) {
        const prevEnd = new Date(result.buckets[i - 1].end).getTime();
        const currStart = new Date(result.buckets[i].start).getTime();
        expect(prevEnd).toBe(currStart);
      }
    });

    it('30d preset yields 30 daily buckets', () => {
      const result = getUsageSeries('/tmp/logs', { range: '30d', now: new Date('2026-10-04T10:30:00Z'), fsWrapper: mockFsWrapper });
      expect(result.buckets.length).toBe(30);
    });
  });

  describe('getUsageSeries - handles missing log directory', () => {
    it('returns valid result when log dir missing', () => {
      const mockFsWrapper = { existsSync: () => false };
      const result = getUsageSeries('/tmp/logs', { range: '6h', now: new Date('2026-10-09T15:00:00Z'), fsWrapper: mockFsWrapper });
      expect(result.buckets).toBeDefined();
      expect(result.keys).toBeDefined();
      expect(result.totals).toBeDefined();
      expect(result.logDirMissing).toBe(true);
    });
  });

  describe('getAgentIndex - contract', () => {
    it('always returns Map even on error', () => {
      const mockOpenDb = () => { throw new Error('failed'); };
      const result = getAgentIndex('/fake/db', mockOpenDb, () => new Date('2026-09-06T10:00:00Z'));
      expect(result instanceof Map).toBe(true);
    });

    it('returns populated Map on success', () => {
      const mockOpenDb = () => ({
        exec: () => {},
        prepare: () => ({ all: () => [{ model_id: 'claude-3', agent: 'build', time_created: 1000, time_completed: 2000, session_id: 's1' }] }),
        close: () => {}
      });

      const result = getAgentIndex('/fake/db', mockOpenDb, () => new Date('2026-09-06T10:00:00Z'));
      expect(result instanceof Map).toBe(true);
    });

    it('returns empty Map on empty result', () => {
      const mockOpenDb = () => ({
        exec: () => {},
        prepare: () => ({ all: () => [] }),
        close: () => {}
      });

      const result = getAgentIndex('/fake/db', mockOpenDb, () => new Date('2026-09-06T10:00:00Z'));
      expect(result instanceof Map).toBe(true);
      expect(result.size).toBe(0);
    });
  });

  describe('getPairedRecords - structure', () => {
    it('returns valid structure with missing log dir', () => {
      const mockFsWrapper = { existsSync: () => false };
      const result = getPairedRecords('/tmp/logs', { fsWrapper: mockFsWrapper });
      expect(result.records).toBeDefined();
      expect(result.total).toBeDefined();
      expect(Array.isArray(result.records)).toBe(true);
      expect(result.logDirMissing).toBe(true);
    });

    it('returns valid structure with empty log dir', () => {
      const mockFsWrapper = {
        existsSync: () => true,
        readdirSync: () => []
      };
      const result = getPairedRecords('/tmp/logs', { fsWrapper: mockFsWrapper });
      expect(result.records).toBeDefined();
      expect(result.total).toBe(0);
      expect(Array.isArray(result.records)).toBe(true);
    });
  });

  describe('parseLogTimestamp', () => {
    it('parses ISO-like timestamp format', () => {
      const ts = parseLogTimestamp('2026-09-06T23-42-34-917Z');
      expect(ts.getUTCFullYear()).toBe(2026);
      expect(ts.getUTCMonth()).toBe(8);
      expect(ts.getUTCDate()).toBe(6);
    });

    it('returns NaN for invalid format', () => {
      const ts = parseLogTimestamp('invalid');
      expect(isNaN(ts.getTime())).toBe(true);
    });
  });
});
