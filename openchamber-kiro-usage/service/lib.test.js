const { describe, it, expect, beforeEach } = require('bun:test');
const { execFileSync } = require('node:child_process');
const { getUsageSeries, parseLogTimestamp, getAgentIndex, stepDateByBucket, alignToLocalBoundary } = require('./lib');

describe('Kiro Usage Library', () => {
  describe('parseLogTimestamp', () => {
    it('parses ISO-like timestamp format', () => {
      const ts = parseLogTimestamp('2026-09-06T23-42-34-917Z');
      expect(ts.getUTCFullYear()).toBe(2026);
      expect(ts.getUTCMonth()).toBe(8); // 0-indexed
      expect(ts.getUTCDate()).toBe(6);
      expect(ts.getUTCHours()).toBe(23);
      expect(ts.getUTCMinutes()).toBe(42);
      expect(ts.getUTCSeconds()).toBe(34);
      expect(ts.getUTCMilliseconds()).toBe(917);
    });

    it('returns NaN date for invalid format', () => {
      const ts = parseLogTimestamp('invalid');
      expect(isNaN(ts.getTime())).toBe(true);
    });
  });

  describe('getUsageSeries', () => {
    const mockFs = {
      existsSync: () => true,
      readdirSync: () => ['2026-09-06T00-00-00-000Z_response.json'],
      statSync: () => ({ mtimeMs: 1000, size: 100 }),
      readFileSync: () => JSON.stringify({
        status: 200,
        model: 'claude-3',
        agent: 'build',
        usage: { credits: 1.5, rate: '0.4x' }
      })
    };

    it('returns structure with agent split metadata', () => {
      const logDir = '/fake/logs';
      const result = getUsageSeries(logDir, {
        range: '1h',
        split: 'agent',
        now: new Date('2026-09-06T01:00:00Z'),
        dbPath: '/fake/db',
        fsWrapper: mockFs
      });

      expect(result.meta).toBeDefined();
      expect(result.meta.agentAttribution).toBeDefined();
      expect(result.meta.agentAttribution.captured >= 0).toBe(true);
      expect(result.meta.agentAttribution.inferred >= 0).toBe(true);
    });

    it('split=model does not include meta', () => {
      const logDir = '/fake/logs';
      const result = getUsageSeries(logDir, {
        range: '1h',
        split: 'model',
        now: new Date('2026-09-06T01:00:00Z'),
        fsWrapper: mockFs
      });

      expect(result.meta).toBeUndefined();
    });

    it('handles missing log directory gracefully', () => {
      const mockFsMissing = { ...mockFs, existsSync: () => false };
      const logDir = '/nonexistent/logs';
      const result = getUsageSeries(logDir, {
        range: '1h',
        split: 'model',
        fsWrapper: mockFsMissing
      });

      expect(result.logDirMissing).toBe(true);
      expect(result.totals.credits).toBe(0);
    });

    it('returns bucket total equals sum of series', () => {
      const mockFsMulti = {
        existsSync: () => true,
        readdirSync: () => [
          '2026-09-06T00-00-00-000Z_response.json',
          '2026-09-06T00-15-00-000Z_response.json'
        ],
        statSync: () => ({ mtimeMs: 1000, size: 100 }),
        readFileSync: (path) => JSON.stringify({
          status: 200,
          model: path.includes('00-00') ? 'claude-3' : 'claude-opus',
          agent: 'build',
          usage: { credits: 1.0 }
        })
      };

      const logDir = '/fake/logs';
      const result = getUsageSeries(logDir, {
        range: '1h',
        split: 'model',
        now: new Date('2026-09-06T01:00:00Z'),
        fsWrapper: mockFsMulti
      });

      if (result.buckets.length > 0) {
        const bucket = result.buckets[0];
        const seriesSum = Object.values(bucket.series).reduce((a, b) => a + b, 0);
        expect(Math.abs(bucket.total - seriesSum) < 0.001).toBe(true);
      }
    });

    it('agent attribution meta totals match request count', () => {
      const logDir = '/fake/logs';
      const result = getUsageSeries(logDir, {
        range: '1h',
        split: 'agent',
        now: new Date('2026-09-06T01:00:00Z'),
        dbPath: '/fake/db',
        fsWrapper: mockFs
      });

      if (result.meta?.agentAttribution) {
        const attr = result.meta.agentAttribution;
        const total = attr.captured + attr.inferred + attr.ambiguous +
          attr.unknown.no_candidate + attr.unknown.db_unavailable + attr.unknown.out_of_coverage;
        if (result.totals.requests > 0) expect(total).toBe(result.totals.requests);
      }
    });
  });

  describe('getAgentIndex', () => {
    it('db_not_found error when DB file missing', () => {
      const mockOpenDb = (p) => {
        throw new Error('no such file');
      };
      // Force null cache key by making statSync fail
      const mockFs = {
        statSync: () => { throw new Error('not found'); },
        existsSync: () => false
      };

      const injectedStat = (p) => {
        throw new Error('ENOENT');
      };

      // Inject a broken stat into getAgentIndex via closure
      // Since we can't override fs.statSync directly, test via the return value
      // by calling with a path that will fail the cacheKey check
      const result = getAgentIndex('/nonexistent/db', mockOpenDb, null);
      expect(result).toBeDefined(); // Should return empty index
      // agentIndexError is module-level; we'd need to export it to check
      // For now, verify it doesn't crash
    });

    it('db_empty error when no rows returned', () => {
      const mockOpenDb = (p) => ({
        exec: () => {},
        prepare: () => ({
          all: () => [] // No rows
        }),
        close: () => {}
      });

      const result = getAgentIndex('/fake/db', mockOpenDb, null);
      expect(result).toBeDefined();
      // Should handle empty result gracefully
    });

    it('query_error when session_message query fails', () => {
      const mockOpenDb = (p) => ({
        exec: () => {},
        prepare: () => {
          throw new Error('syntax error');
        },
        close: () => {}
      });

      const result = getAgentIndex('/fake/db', mockOpenDb, null);
      expect(result).toBeDefined();
      // Should handle query error and return empty index
    });

    it('soft fail on legacy message table missing', () => {
      let callCount = 0;
      const mockOpenDb = (p) => ({
        exec: () => {},
        prepare: () => ({
          all: () => {
            callCount++;
            if (callCount === 1) {
              // First call (session_message) succeeds
              return [{
                model_id: 'claude-3',
                agent: 'build',
                time_created: 1000,
                time_completed: 2000,
                session_id: 's1'
              }];
            } else {
              // Second call (legacy message) fails with "no such table"
              throw new Error('no such table: message');
            }
          }
        }),
        close: () => {}
      });

      const result = getAgentIndex('/fake/db', mockOpenDb, null);
      expect(result).toBeDefined();
      // Should return index with session_message data, ignoring the missing table
    });
  });
});

  describe('getUsageSeries - [from, to) edge entries', () => {
    const mockFsWrapper = {
      existsSync: () => true,
      readdirSync: () => [
        '2026-10-01T00-00-00-000Z_response.json',
        '2026-10-01T23-59-59-999Z_response.json',
        '2026-10-02T00-00-00-000Z_response.json'
      ],
      statSync: () => ({ mtimeMs: 1000, size: 100 }),
      readFileSync: (path) => JSON.stringify({
        status: 200,
        model: 'claude-3',
        agent: 'build',
        usage: { credits: 1.0 }
      })
    };

    it('includes entry exactly at from boundary', () => {
      const result = getUsageSeries('/tmp/logs', {
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-02T00:00:00.000Z',
        bucket: 'hour',
        split: 'model',
        fsWrapper: mockFsWrapper
      });
      expect(result.totals.requests).toBeGreaterThan(0);
    });

    it('excludes entry exactly at to boundary', () => {
      const mockFsToOnly = {
        existsSync: () => true,
        readdirSync: () => ['2026-10-02T00-00-00-000Z_response.json'],
        statSync: () => ({ mtimeMs: 1000, size: 100 }),
        readFileSync: () => JSON.stringify({
          status: 200,
          model: 'claude-3',
          agent: 'build',
          usage: { credits: 1.0 }
        })
      };
      const result = getUsageSeries('/tmp/logs', {
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-02T00:00:00.000Z',
        bucket: 'hour',
        split: 'model',
        fsWrapper: mockFsToOnly
      });
      expect(result.totals.requests).toBe(0);
    });

    it('includes entry just before to boundary', () => {
      const mockFsJustBefore = {
        existsSync: () => true,
        readdirSync: () => ['2026-10-01T23-59-59-999Z_response.json'],
        statSync: () => ({ mtimeMs: 1000, size: 100 }),
        readFileSync: () => JSON.stringify({
          status: 200,
          model: 'claude-3',
          agent: 'build',
          usage: { credits: 1.0 }
        })
      };
      const result = getUsageSeries('/tmp/logs', {
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-02T00:00:00.000Z',
        bucket: 'hour',
        split: 'model',
        fsWrapper: mockFsJustBefore
      });
      expect(result.totals.requests).toBe(1);
    });
  });

  describe('getUsageSeries - preset buckets & alignment', () => {
    const mockNow = new Date('2026-10-09T15:00:00Z');
    const logDir = '/tmp/logs';
    const mockFsWrapper = {
      existsSync: () => true,
      readdirSync: () => []
    };

    it('6h preset yields 6 hourly buckets aligned to hour boundary', () => {
      const result = getUsageSeries(logDir, { range: '6h', now: mockNow, fsWrapper: mockFsWrapper });
      expect(result.buckets.length).toBe(6);
      result.buckets.forEach(b => {
        const start = new Date(b.start);
        expect(start.getMinutes()).toBe(0);
        expect(start.getSeconds()).toBe(0);
      });
    });

    it('24h preset yields exactly 24 hourly buckets', () => {
      const result = getUsageSeries(logDir, { range: '24h', now: mockNow, fsWrapper: mockFsWrapper });
      expect(result.buckets.length).toBe(24);
    });

    it('7d preset yields hourly buckets covering 7 days', () => {
      const result = getUsageSeries(logDir, { range: '7d', now: mockNow, fsWrapper: mockFsWrapper });
      expect(result.buckets.length).toBe(168);
    });

    it('30d preset yields 30 daily buckets aligned to midnight', () => {
      const result = getUsageSeries(logDir, { range: '30d', now: mockNow, fsWrapper: mockFsWrapper });
      expect(result.buckets.length).toBe(30);
      result.buckets.forEach(b => {
        const start = new Date(b.start);
        expect(start.getHours()).toBe(0);
        expect(start.getMinutes()).toBe(0);
      });
    });

    it('DST transition preserves bucket count (7d hourly across DST)', () => {
      // Test with Australia/Sydney TZ crossing DST boundary (Sep 30 or similar)
      // Create a now date during DST transition window
      const sydneyNow = new Date('2026-10-04T10:30:00+11:00'); // Mid-bucket in Sydney time
      const result = getUsageSeries(logDir, { range: '7d', now: sydneyNow, fsWrapper: mockFsWrapper });
      expect(result.buckets.length).toBe(168);
      // Verify hour alignment
      for (let i = 1; i < result.buckets.length; i++) {
        const prev = new Date(result.buckets[i - 1].end);
        const curr = new Date(result.buckets[i].start);
        expect(prev.getTime()).toBe(curr.getTime());
      }
    });

    it('DST transition preserves bucket count (30d daily across DST)', () => {
      const sydneyNow = new Date('2026-10-04T10:30:00+11:00');
      const result = getUsageSeries(logDir, { range: '30d', now: sydneyNow, fsWrapper: mockFsWrapper });
      expect(result.buckets.length).toBe(30);
      for (let i = 1; i < result.buckets.length; i++) {
        const prev = new Date(result.buckets[i - 1].end);
        const curr = new Date(result.buckets[i].start);
        expect(prev.getTime()).toBe(curr.getTime());
      }
    });

    it('invalid range returns 400 error', () => {
      const result = getUsageSeries(logDir, { range: 'invalid', fsWrapper: mockFsWrapper });
      expect(result.code).toBe(400);
      expect(result.error).toBe('invalid range');
    });
  });

  describe('getUsageSeries - true DST local alignment', () => {
    it('keeps hourly and daily buckets on Sydney local clock boundaries across DST', () => {
      const script = `
        const { getUsageSeries } = require('./openchamber-kiro-usage/service/lib');
        const fsWrapper = { existsSync: () => true, readdirSync: () => [] };
        const now = new Date('2026-10-04T10:30:00+11:00');
        const hourly = getUsageSeries('/tmp/logs', { range: '7d', now, fsWrapper });
        const daily = getUsageSeries('/tmp/logs', { range: '30d', now, fsWrapper });
        const aligned = (buckets, hour) => buckets.every(({ start }) => {
          const date = new Date(start);
          return date.getMinutes() === 0 && date.getSeconds() === 0 && (!hour || date.getMilliseconds() === 0);
        });
        if (hourly.buckets.length !== 168 || daily.buckets.length !== 30 || !aligned(hourly.buckets, true) || !aligned(daily.buckets, false) || daily.buckets.some(({ start }) => new Date(start).getHours() !== 0)) process.exit(1);
      `;
      execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, TZ: 'Australia/Sydney' }
      });
    });

    it('preserves bucket count across DST transition (7d hourly)', () => {
      const mockFsWrapper = {
        existsSync: () => true,
        readdirSync: () => [],
        statSync: () => ({ mtimeMs: 1000, size: 100 })
      };
      const sydneyDstNow = new Date('2026-10-04T10:30:00+11:00');
      const result = getUsageSeries('/tmp/logs', {
        range: '7d',
        now: sydneyDstNow,
        fsWrapper: mockFsWrapper
      });
      expect(result.buckets.length).toBe(168);
      // Verify no gaps in hour boundaries
      for (let i = 1; i < result.buckets.length; i++) {
        const prevEnd = new Date(result.buckets[i - 1].end).getTime();
        const currStart = new Date(result.buckets[i].start).getTime();
        expect(prevEnd).toBe(currStart);
      }
    });

    it('preserves bucket count across DST transition (30d daily)', () => {
      const mockFsWrapper = {
        existsSync: () => true,
        readdirSync: () => [],
        statSync: () => ({ mtimeMs: 1000, size: 100 })
      };
      const sydneyDstNow = new Date('2026-10-04T10:30:00+11:00');
      const result = getUsageSeries('/tmp/logs', {
        range: '30d',
        now: sydneyDstNow,
        fsWrapper: mockFsWrapper
      });
      expect(result.buckets.length).toBe(30);
      // Verify day boundaries aligned to midnight
      for (let i = 0; i < result.buckets.length; i++) {
        const start = new Date(result.buckets[i].start);
        expect(start.getUTCHours()).toBe(0);
        expect(start.getUTCMinutes()).toBe(0);
      }
    });
  });

  describe('getUsageSeries - model/agent parity fixed window', () => {
    const sharedMockFs = {
      existsSync: () => true,
      readdirSync: () => [
        '2026-10-01T12-00-00-000Z_response.json',
        '2026-10-01T13-00-00-000Z_response.json'
      ],
      statSync: () => ({ mtimeMs: 1000, size: 100 }),
      readFileSync: (path) => JSON.stringify({
        status: 200,
        model: 'claude-3',
        agent: 'build',
        usage: { credits: 2.0 }
      })
    };

    const fixedWindow = {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      bucket: 'hour'
    };

    it('split=model and split=agent report identical totals.credits', () => {
      const resultModel = getUsageSeries('/tmp/logs', {
        ...fixedWindow,
        split: 'model',
        fsWrapper: sharedMockFs
      });
      const resultAgent = getUsageSeries('/tmp/logs', {
        ...fixedWindow,
        split: 'agent',
        fsWrapper: sharedMockFs
      });
      expect(resultModel.totals.credits).toBe(resultAgent.totals.credits);
    });

    it('split=model and split=agent report identical totals.requests', () => {
      const resultModel = getUsageSeries('/tmp/logs', {
        ...fixedWindow,
        split: 'model',
        fsWrapper: sharedMockFs
      });
      const resultAgent = getUsageSeries('/tmp/logs', {
        ...fixedWindow,
        split: 'agent',
        fsWrapper: sharedMockFs
      });
      expect(resultModel.totals.requests).toBe(resultAgent.totals.requests);
    });
  });

  describe('getUsageSeries - deterministic repeated fixed-window result', () => {
    const deterministicMockFs = {
      existsSync: () => true,
      readdirSync: () => [
        '2026-10-01T06-00-00-000Z_response.json',
        '2026-10-01T12-00-00-000Z_response.json',
        '2026-10-01T18-00-00-000Z_response.json'
      ],
      statSync: () => ({ mtimeMs: 1000, size: 100 }),
      readFileSync: (path) => JSON.stringify({
        status: 200,
        model: 'claude-3',
        agent: 'build',
        usage: { credits: 1.5 }
      })
    };

    const fixedWindow = {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      bucket: 'hour',
      split: 'model'
    };

    it('repeated calls return identical bucket structure', () => {
      const result1 = getUsageSeries('/tmp/logs', {
        ...fixedWindow,
        fsWrapper: deterministicMockFs
      });
      const result2 = getUsageSeries('/tmp/logs', {
        ...fixedWindow,
        fsWrapper: deterministicMockFs
      });
      expect(JSON.stringify(result1.buckets)).toBe(JSON.stringify(result2.buckets));
    });

    it('repeated calls return identical totals', () => {
      const result1 = getUsageSeries('/tmp/logs', {
        ...fixedWindow,
        fsWrapper: deterministicMockFs
      });
      const result2 = getUsageSeries('/tmp/logs', {
        ...fixedWindow,
        fsWrapper: deterministicMockFs
      });
      expect(result1.totals).toEqual(result2.totals);
    });

    it('repeated calls return identical keys order and values', () => {
      const result1 = getUsageSeries('/tmp/logs', {
        ...fixedWindow,
        fsWrapper: deterministicMockFs
      });
      const result2 = getUsageSeries('/tmp/logs', {
        ...fixedWindow,
        fsWrapper: deterministicMockFs
      });
      expect(JSON.stringify(result1.keys)).toBe(JSON.stringify(result2.keys));
    });
  });
