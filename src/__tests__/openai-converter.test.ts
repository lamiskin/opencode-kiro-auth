import { describe, expect, test } from 'bun:test'
import { convertToOpenAI } from '../plugin/streaming/openai-converter.js'

describe('convertToOpenAI', () => {
  test('skips Anthropic-only events instead of emitting empty choices', () => {
    expect(
      convertToOpenAI({ type: 'content_block_stop', index: 0 }, 'chatcmpl-test', 'auto')
    ).toBeNull()
    expect(convertToOpenAI({ type: 'message_stop' }, 'chatcmpl-test', 'auto')).toBeNull()
  })

  test('skips empty reasoning deltas instead of emitting empty choices', () => {
    const chunk = convertToOpenAI(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '' }
      },
      'chatcmpl-test',
      'auto'
    )

    expect(chunk).toBeNull()
  })

  test('passes cache read tokens through as prompt_tokens_details.cached_tokens', () => {
    const chunk = convertToOpenAI(
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 500, output_tokens: 20, cache_read_input_tokens: 400 }
      } as any,
      'chatcmpl-test',
      'auto'
    )
    expect(chunk.usage.prompt_tokens_details.cached_tokens).toBe(400)
    expect(chunk.usage.cache_read_input_tokens).toBe(400)
  })

  test('defaults cached_tokens to 0 when no cache usage is reported', () => {
    const chunk = convertToOpenAI(
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 500, output_tokens: 20 }
      } as any,
      'chatcmpl-test',
      'auto'
    )
    expect(chunk.usage.prompt_tokens_details.cached_tokens).toBe(0)
  })
})
