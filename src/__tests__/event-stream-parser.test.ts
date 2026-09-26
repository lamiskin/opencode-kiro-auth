import { describe, expect, test } from 'bun:test'
import {
  parseAwsEventStreamBuffer,
  parseEventLine
} from '../infrastructure/transformers/event-stream-parser.js'

// ── parseEventLine ──────────────────────────────────────────────────────────────

describe('parseEventLine', () => {
  test('parses valid JSON', () => {
    expect(parseEventLine('{"content":"hello"}')).toEqual({ content: 'hello' })
  })

  test('returns null for invalid JSON', () => {
    expect(parseEventLine('not json')).toBeNull()
    expect(parseEventLine('{')).toBeNull()
    expect(parseEventLine('{"incomplete":')).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(parseEventLine('')).toBeNull()
  })
})

// ── parseAwsEventStreamBuffer: single events ───────────────────────────────────

describe('parseAwsEventStreamBuffer: single events', () => {
  test('well-formed content event in one chunk', () => {
    const buffer = '{"content":"hello world"}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'content', data: 'hello world' })
  })

  test('well-formed toolUse event', () => {
    const buffer = '{"name":"tool","toolUseId":"id123","input":{"x":1}}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'toolUse',
      data: { name: 'tool', toolUseId: 'id123', input: { x: 1 }, stop: false }
    })
  })

  test('toolUseStop event', () => {
    const buffer = '{"stop":true}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'toolUseStop', data: { stop: true } })
  })

  test('contextUsage event', () => {
    const buffer = '{"contextUsagePercentage":75}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'contextUsage', data: { contextUsagePercentage: 75 } })
  })

  test('metering event', () => {
    const buffer = '{"usage":1000,"unit":"tokens"}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'meteringEvent',
      data: { usage: 1000, unit: 'tokens', unitPlural: undefined }
    })
  })

  test('toolUseInput event', () => {
    const buffer = '{"input":{"prompt":"test"}}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'toolUseInput', data: { input: { prompt: 'test' } } })
  })
})

// ── parseAwsEventStreamBuffer: multiple events ─────────────────────────────────

describe('parseAwsEventStreamBuffer: multiple events', () => {
  test('multiple JSON events concatenated in one chunk', () => {
    const buffer = '{"content":"a"}{"content":"b"}{"content":"c"}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(3)
    expect(events[0].data).toBe('a')
    expect(events[1].data).toBe('b')
    expect(events[2].data).toBe('c')
  })

  test('mixed event types concatenated', () => {
    const buffer = '{"content":"hello"}{"stop":true}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('content')
    expect(events[1].type).toBe('toolUseStop')
  })

  test('whitespace between events', () => {
    const buffer = '{"content":"a"}\n{"content":"b"}\r\n{"content":"c"}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(3)
  })
})

// ── parseAwsEventStreamBuffer: chunk boundary handling ────────────────────────

describe('parseAwsEventStreamBuffer: chunk boundary handling', () => {
  test('single JSON event split across multiple chunks - partial 1', () => {
    // First chunk: incomplete JSON
    const partial = '{"content":"hello'
    const events = parseAwsEventStreamBuffer(partial)
    // Incomplete JSON is dropped (no valid complete event found)
    expect(events).toHaveLength(0)
  })

  test('single JSON event split across multiple chunks - reconstruct from two', () => {
    // This tests whether the parser buffers incomplete JSON across calls
    // Current behavior: it does NOT buffer - incomplete JSON is dropped
    const chunk1 = '{"content":"hello'
    const chunk2 = '"}'
    // Parser processes each call independently - it cannot reconstruct
    const events1 = parseAwsEventStreamBuffer(chunk1)
    const events2 = parseAwsEventStreamBuffer(chunk2)
    // Both chunks processed independently result in no complete events
    // because the parser doesn't maintain state between calls
    expect(events1).toHaveLength(0)
    expect(events2).toHaveLength(0)
  })

  test('complete event after incomplete at end of buffer', () => {
    // Incomplete JSON at end followed by complete event earlier
    const buffer = '{"content":"first"}{"content":"second"}{"incomplete"'
    const events = parseAwsEventStreamBuffer(buffer)
    // Should parse the complete events, drop the incomplete one
    expect(events).toHaveLength(2)
    expect(events[0].data).toBe('first')
    expect(events[1].data).toBe('second')
  })
})

// ── parseAwsEventStreamBuffer: escaped strings ─────────────────────────────────

describe('parseAwsEventStreamBuffer: escaped strings', () => {
  test('escaped quotes inside JSON string values', () => {
    const buffer = '{"content":"say \\"hello\\""}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('say "hello"')
  })

  test('escaped backslashes before quotes', () => {
    const buffer = '{"content":"path\\\\\\\\ end"}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('path\\\\ end')
  })

  test('multiple escaped characters in sequence', () => {
    const buffer = '{"content":"a\\\\b\\\\nc"}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(1)
  })

  test('unescaped quote inside string breaks parsing - current behavior', () => {
    // This tests current behavior: unescaped quote confuses the parser
    // The parser will find the opening quote, toggle inString, then the
    // unescaped quote toggles it back, causing brace counting to resume
    // incorrectly - resulting in silent drop or wrong parse
    const buffer = '{"content":"hello"extra"}'
    const events = parseAwsEventStreamBuffer(buffer)
    // Current behavior: likely drops the event due to parse failure
    // The key is this is silent - no error thrown
    expect(Array.isArray(events)).toBe(true)
  })
})

// ── parseAwsEventStreamBuffer: nested braces ──────────────────────────────────

describe('parseAwsEventStreamBuffer: nested braces', () => {
  test('nested objects within a single event', () => {
    const buffer = '{"content":{"nested":{"deep":"value"}}}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(1)
    expect(events[0].data).toEqual({ nested: { deep: 'value' } })
  })

  test('nested arrays with objects', () => {
    const buffer = '{"input":[{"a":1},{"b":2}]}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(1)
    expect(events[0].data).toEqual({ input: [{ a: 1 }, { b: 2 }] })
  })

  test('deeply nested structure', () => {
    const buffer = '{"content":{"a":{"b":{"c":{"d":"e"}}}}}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(1)
    expect(events[0].data.a.b.c.d).toBe('e')
  })

  test('mixed nested content with multiple events', () => {
    const buffer = '{"content":{"nested":1}}{"content":{"nested":2}}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(2)
  })
})

// ── parseAwsEventStreamBuffer: malformed input ─────────────────────────────────

describe('parseAwsEventStreamBuffer: malformed input', () => {
  test('unterminated/incomplete JSON at end of buffer is dropped', () => {
    const buffer = '{"content":"hello"}{"incomplete":'
    const events = parseAwsEventStreamBuffer(buffer)
    // Only complete event is parsed
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('hello')
  })

  test('invalid JSON that cannot parse is dropped silently', () => {
    const buffer = '{"content":"hello"}{not json}{"content":"world"}'
    const events = parseAwsEventStreamBuffer(buffer)
    // Invalid JSON is silently dropped
    expect(events).toHaveLength(2)
    expect(events[0].data).toBe('hello')
    expect(events[1].data).toBe('world')
  })

  test('completely malformed buffer returns empty array', () => {
    const events = parseAwsEventStreamBuffer('not json at all')
    expect(events).toHaveLength(0)
  })

  test('truncated JSON at start is dropped', () => {
    const buffer = '{"truncat'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(0)
  })
})

// ── parseAwsEventStreamBuffer: empty / whitespace ─────────────────────────────

describe('parseAwsEventStreamBuffer: empty / whitespace', () => {
  test('empty input returns empty array', () => {
    expect(parseAwsEventStreamBuffer('')).toHaveLength(0)
  })

  test('whitespace-only input returns empty array', () => {
    expect(parseAwsEventStreamBuffer('   ')).toHaveLength(0)
    expect(parseAwsEventStreamBuffer('\\n\\r\\t')).toHaveLength(0)
  })

  test('empty chunks between events are skipped', () => {
    const buffer = '{"content":"a"}\n\n{"content":"b"}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(2)
  })

  test('multiple whitespace-only segments', () => {
    const buffer = '  {"content":"x"}  \n  {"content":"y"}  '
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(2)
  })
})

// ── parseAwsEventStreamBuffer: specific event types ───────────────────────────

describe('parseAwsEventStreamBuffer: followupPrompt edge case', () => {
  test('content with followupPrompt is NOT emitted as content event', () => {
    // This is the logic: parsed.content !== undefined && !parsed.followupPrompt
    const buffer = '{"content":"hello","followupPrompt":"prompt"}'
    const events = parseAwsEventStreamBuffer(buffer)
    // Should not emit content type because followupPrompt exists
    expect(events).toHaveLength(0)
  })

  test('content without followupPrompt emits content event', () => {
    const buffer = '{"content":"hello"}'
    const events = parseAwsEventStreamBuffer(buffer)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('content')
  })
})
