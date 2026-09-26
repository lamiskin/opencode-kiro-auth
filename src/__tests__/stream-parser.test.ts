import { describe, expect, test } from 'bun:test'
import { findRealTag, parseStreamBuffer } from '../plugin/streaming/stream-parser.js'

describe('parseStreamBuffer', () => {
  test('parses well-formed content event', () => {
    const buffer = '{"content":"hello world"}'
    const result = parseStreamBuffer(buffer)

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toEqual({ type: 'content', data: 'hello world' })
    expect(result.remaining).toBe('')
  })

  test('parses multiple events in one buffer', () => {
    const buffer = '{"content":"hello"}{"content":"world"}'
    const result = parseStreamBuffer(buffer)

    expect(result.events).toHaveLength(2)
    expect(result.events[0]).toEqual({ type: 'content', data: 'hello' })
    expect(result.events[1]).toEqual({ type: 'content', data: 'world' })
    expect(result.remaining).toBe('')
  })

  test('handles partial incomplete JSON at end of buffer', () => {
    const buffer = '{"content":"hello"}{"partial"'
    const result = parseStreamBuffer(buffer)

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toEqual({ type: 'content', data: 'hello' })
    expect(result.remaining).toBe('{"partial"')
  })

  test('returns partial JSON as remaining when not closed', () => {
    const buffer = '{"content":"test"}{"content":'
    const result = parseStreamBuffer(buffer)

    expect(result.events).toHaveLength(1)
    expect(result.remaining).toBe('{"content":')
  })

  test('handles partial event that completes in next call', () => {
    // First call with incomplete JSON
    const first = parseStreamBuffer('{"content":"first"}{"content":"secon')
    expect(first.events).toHaveLength(1)
    expect(first.events[0].data).toBe('first')
    expect(first.remaining).toBe('{"content":"secon')

    // Second call with the completion
    const second = parseStreamBuffer(first.remaining + 'd"}')
    expect(second.events).toHaveLength(1)
    expect(second.events[0].data).toBe('second')
    expect(second.remaining).toBe('')
  })

  test('parses toolUse event with name and toolUseId', () => {
    const buffer = '{"name":"tool_name","toolUseId":"uuid-123","input":{"key":"value"}}'
    const result = parseStreamBuffer(buffer)

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toEqual({
      type: 'toolUse',
      data: {
        name: 'tool_name',
        toolUseId: 'uuid-123',
        input: { key: 'value' },
        stop: false
      }
    })
  })

  test('parses toolUseInput event', () => {
    const buffer = '{"input":"some input"}'
    const result = parseStreamBuffer(buffer)

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toEqual({
      type: 'toolUseInput',
      data: { input: 'some input' }
    })
  })

  test('parses toolUseStop event', () => {
    const buffer = '{"stop":true}'
    const result = parseStreamBuffer(buffer)

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toEqual({
      type: 'toolUseStop',
      data: { stop: true }
    })
  })

  test('parses contextUsage event', () => {
    const buffer = '{"contextUsagePercentage":75}'
    const result = parseStreamBuffer(buffer)

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toEqual({
      type: 'contextUsage',
      data: { contextUsagePercentage: 75 }
    })
  })

  test('parses metering/usage event', () => {
    const buffer = '{"usage":100,"unit":"tokens"}'
    const result = parseStreamBuffer(buffer)

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toEqual({
      type: 'meteringEvent',
      data: { usage: 100, unit: 'tokens', unitPlural: undefined }
    })
  })

  test('handles empty buffer', () => {
    const result = parseStreamBuffer('')

    expect(result.events).toHaveLength(0)
    expect(result.remaining).toBe('')
  })

  test('handles buffer with no recognizable events', () => {
    const buffer = 'just some plain text without json'
    const result = parseStreamBuffer(buffer)

    expect(result.events).toHaveLength(0)
    // The remaining should be the full buffer since no JSON was found
    expect(result.remaining).toBe('just some plain text without json')
  })

  test('handles buffer with only whitespace', () => {
    const result = parseStreamBuffer('   \n\t   ')

    expect(result.events).toHaveLength(0)
    expect(result.remaining).toBe('   \n\t   ')
  })

  test('skips followupPrompt content events', () => {
    const buffer = '{"content":"normal"}{"followupPrompt":"prompt","content":"should skip"}'
    const result = parseStreamBuffer(buffer)

    expect(result.events).toHaveLength(1)
    expect(result.events[0].data).toBe('normal')
  })

  test('handles mixed event types in sequence', () => {
    const buffer = '{"content":"hi"}{"name":"tool","toolUseId":"u1","input":{}}{"stop":true}'
    const result = parseStreamBuffer(buffer)

    expect(result.events).toHaveLength(3)
    expect(result.events[0].type).toBe('content')
    expect(result.events[1].type).toBe('toolUse')
    expect(result.events[2].type).toBe('toolUseStop')
  })

  test('handles JSON with escaped strings', () => {
    const buffer = '{"content":"hello\\\\nworld"}'
    const result = parseStreamBuffer(buffer)

    expect(result.events).toHaveLength(1)
    expect(result.events[0].data).toBe('hello\\nworld')
  })

  test('handles nested braces in strings', () => {
    const buffer = '{"content":"{nested: { object: true }}"}'
    const result = parseStreamBuffer(buffer)

    expect(result.events).toHaveLength(1)
    expect(result.events[0].data).toBe('{nested: { object: true }}')
  })
})

describe('findRealTag', () => {
  test('finds tag outside code blocks', () => {
    const buffer = 'some text <thinking>content</thinking> more text'
    const result = findRealTag(buffer, '<thinking>')

    expect(result).toBe(10)
  })

  test('returns -1 when tag only inside code block', () => {
    const buffer = '```\n<thinking>inside code</thinking>\n```'
    const result = findRealTag(buffer, '<thinking>')

    expect(result).toBe(-1)
  })

  test('finds tag after code block', () => {
    const buffer = '```\n<thinking>skip</thinking>\n```\n<thinking>found</thinking>'
    const result = findRealTag(buffer, '<thinking>')

    expect(result).toBeGreaterThan(30)
  })

  test('finds tag before code block', () => {
    const buffer = '<thinking>found</thinking>\n```\n<thinking>skip</thinking>\n```'
    const result = findRealTag(buffer, '<thinking>')

    expect(result).toBe(0)
  })

  test('handles multiple code blocks', () => {
    const buffer = '```\na\n```\n<thinking>found</thinking>\n```\nb\n```'
    const result = findRealTag(buffer, '<thinking>')

    expect(result).toBeGreaterThanOrEqual(10)
    expect(result).toBeLessThan(30)
  })

  test('returns -1 when tag not present', () => {
    const buffer = 'no tags here'
    const result = findRealTag(buffer, '<thinking>')

    expect(result).toBe(-1)
  })

  test('finds </thinking> end tag', () => {
    const buffer = 'text<thinking>content</thinking>end'
    const result = findRealTag(buffer, '</thinking>')

    expect(result).toBe(21)
  })

  test('handles empty buffer', () => {
    const result = findRealTag('', '<thinking>')

    expect(result).toBe(-1)
  })

  test('handles code block with similar tag-like content', () => {
    const buffer = '```\nconst tag = "<thinking>";\n```\n<real>content</real>'
    const result = findRealTag(buffer, '<thinking>')

    expect(result).toBe(-1)
  })
})

describe('buffer boundary handling with thinking tags', () => {
  test('partial thinking start tag at buffer boundary', () => {
    // JSON with unclosed string followed by partial tag - string isn't closed so entire thing is partial
    const first = parseStreamBuffer('{"content":"hello"}<think')
    expect(first.events).toHaveLength(1)
    expect(first.remaining).toBe('<think')

    // Second chunk - the partial <think doesn't form valid JSON
    const second = parseStreamBuffer(first.remaining + 'ing>thoughts')
    // The tag content isn't valid JSON so no events parsed
    expect(second.remaining).toContain('ing>thoughts')
  })

  test('findRealTag with partial tag at boundary', () => {
    // Tag that spans buffer boundary should not be found in either
    const buffer = 'prefix <th\ninkin'
    const result = findRealTag(buffer, '<thinking>')

    // The tag is split, so it won't be found
    expect(result).toBe(-1)
  })
})
