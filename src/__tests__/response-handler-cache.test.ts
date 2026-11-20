import { describe, expect, test } from 'bun:test'
import { ResponseHandler } from '../core/request/response-handler.js'

function sdkResponseWithUsage(tokenUsage: Record<string, number>) {
  return {
    generateAssistantResponseResponse: (async function* () {
      yield { assistantResponseEvent: { content: 'hi' } }
      yield { metadataEvent: { tokenUsage } }
    })()
  }
}

describe('non-streaming usage cache details', () => {
  test('passes cacheReadInputTokens through as prompt_tokens_details.cached_tokens', async () => {
    const handler = new ResponseHandler()
    const res = await handler.handleSdkSuccess(
      sdkResponseWithUsage({
        uncachedInputTokens: 100,
        cacheReadInputTokens: 400,
        cacheWriteInputTokens: 7,
        outputTokens: 20,
        totalTokens: 520
      }),
      'auto',
      'conv-1',
      false
    )
    const body: any = await res.json()
    expect(body.usage.prompt_tokens).toBe(100)
    expect(body.usage.prompt_tokens_details.cached_tokens).toBe(400)
    expect(body.usage.cache_read_input_tokens).toBe(400)
    expect(body.usage.cache_creation_input_tokens).toBe(7)
  })

  test('defaults cached_tokens to 0 when the backend reports no cache counts', async () => {
    const handler = new ResponseHandler()
    const res = await handler.handleSdkSuccess(
      sdkResponseWithUsage({ uncachedInputTokens: 100, outputTokens: 20, totalTokens: 120 }),
      'auto',
      'conv-2',
      false
    )
    const body: any = await res.json()
    expect(body.usage.prompt_tokens_details.cached_tokens).toBe(0)
    expect(body.usage.cache_read_input_tokens).toBe(0)
    expect(body.usage.cache_creation_input_tokens).toBe(0)
  })
})
