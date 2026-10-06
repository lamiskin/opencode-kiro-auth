import { restoreToolName } from '../../infrastructure/transformers/tool-transformer.js'
import { debug, logApiUsage } from '../../plugin/logger.js'
import { transformSdkStream } from '../../plugin/streaming/sdk-stream-transformer.js'
import type { ToolNameMap } from '../../plugin/types.js'

interface AccumulatedToolCall {
  toolUseId: string
  name?: string
  input: string
}

export class ResponseHandler {
  // SHOULD FIX #12: handleSuccess/handleStreaming/handleNonStreaming are dead code.
  // Only handleSdkSuccess has callers. Keeping the class for possible future use.

  async handleSdkSuccess(
    sdkResponse: any,
    model: string,
    conversationId: string,
    streaming: boolean,
    toolNameMap?: ToolNameMap,
    apiTimestamp?: string | null
  ): Promise<Response> {
    if (streaming) {
      return this.handleSdkStreaming(sdkResponse, model, conversationId, toolNameMap, apiTimestamp)
    }
    return this.handleSdkNonStreaming(sdkResponse, model, conversationId, toolNameMap, apiTimestamp)
  }

  private async handleSdkStreaming(
    sdkResponse: any,
    model: string,
    conversationId: string,
    toolNameMap?: ToolNameMap,
    apiTimestamp?: string | null
  ): Promise<Response> {
    const s = transformSdkStream(sdkResponse, model, conversationId, toolNameMap)

    // Stream incrementally: iterate manually inside start(c) to capture final return value
    // while still allowing true SSE streaming (time-to-first-token)
    return new Response(
      new ReadableStream({
        async start(c) {
          try {
            while (true) {
              const iterResult = await s.next()
              if (iterResult.done) {
                // Log usage data after stream completes (only if apiTimestamp is provided)
                const finalUsage = iterResult.value
                if (apiTimestamp && finalUsage) {
                  logApiUsage(
                    {
                      inputTokens: finalUsage.inputTokens,
                      outputTokens: finalUsage.outputTokens,
                      totalTokens: finalUsage.totalTokens,
                      cacheReadInputTokens: finalUsage.cacheReadInputTokens,
                      cacheWriteInputTokens: finalUsage.cacheWriteInputTokens,
                      contextUsagePercentage: finalUsage.contextUsagePercentage,
                      credits: finalUsage.meteringUsage ?? undefined
                    },
                    apiTimestamp
                  )
                }
                c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
                c.close()
                break
              }
              c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(iterResult.value)}\n\n`))
            }
          } catch (err) {
            c.error(err)
          }
        }
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }

  private async handleSdkNonStreaming(
    sdkResponse: any,
    model: string,
    conversationId: string,
    toolNameMap?: ToolNameMap,
    apiTimestamp?: string | null
  ): Promise<Response> {
    // For non-streaming SDK responses, collect all events
    let content = ''
    const toolCallFragments = new Map<string, AccumulatedToolCall>()
    const toolCallOrder: string[] = []
    let inputTokens = 0
    let outputTokens = 0
    let totalTokens = 0
    let cacheReadInputTokens: number | undefined
    let cacheWriteInputTokens: number | undefined
    let contextUsagePercentage: number | undefined
    let meteringUsage: number | undefined

    const eventStream = sdkResponse.generateAssistantResponseResponse
    if (eventStream) {
      for await (const event of eventStream) {
        if (event.assistantResponseEvent?.content) {
          content += event.assistantResponseEvent.content
        }
        if (event.toolUseEvent) {
          const fragment = event.toolUseEvent
          const toolUseId = fragment.toolUseId
          if (typeof toolUseId === 'string' && toolUseId.length > 0) {
            let accumulated = toolCallFragments.get(toolUseId)
            if (!accumulated) {
              accumulated = { toolUseId, input: '' }
              toolCallFragments.set(toolUseId, accumulated)
              toolCallOrder.push(toolUseId)
            }
            if (typeof fragment.name === 'string' && fragment.name.length > 0) {
              accumulated.name = fragment.name
            }
            if (fragment.input !== undefined) {
              accumulated.input +=
                typeof fragment.input === 'string'
                  ? fragment.input
                  : (JSON.stringify(fragment.input) ?? '')
            }
          }
        }
        if (event.metadataEvent?.tokenUsage) {
          const usage = event.metadataEvent.tokenUsage
          if (typeof usage.uncachedInputTokens === 'number') {
            inputTokens = usage.uncachedInputTokens
          }
          if (typeof usage.outputTokens === 'number') {
            outputTokens = usage.outputTokens
          }
          if (typeof usage.totalTokens === 'number') {
            totalTokens = usage.totalTokens
          }
          if (typeof usage.cacheReadInputTokens === 'number') {
            cacheReadInputTokens = usage.cacheReadInputTokens
          }
          if (typeof usage.cacheWriteInputTokens === 'number') {
            cacheWriteInputTokens = usage.cacheWriteInputTokens
          }
          if (typeof usage.contextUsagePercentage === 'number') {
            contextUsagePercentage = usage.contextUsagePercentage
          }
        }
        if (event.meteringEvent?.usage !== undefined) {
          meteringUsage = event.meteringEvent.usage
          const usage = event.meteringEvent.usage
          const creditsText = `\n\n_Credits Used: ${usage.toFixed(2)}_`
          content += creditsText
        } else if (event.meteringEvent) {
          debug(`Kiro SDK response completed without meteringUsage captured for model=${model}`)
        }
      }
    }

    const toolCalls = toolCallOrder
      .map((toolUseId) => toolCallFragments.get(toolUseId))
      .filter(
        (toolCall): toolCall is AccumulatedToolCall & { name: string } =>
          typeof toolCall?.name === 'string'
      )

    const oai: any = {
      id: conversationId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
        }
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: totalTokens || inputTokens + outputTokens
      }
    }

    if (toolCalls.length > 0) {
      oai.choices[0].message.tool_calls = toolCalls.map((tc) => ({
        id: tc.toolUseId,
        type: 'function',
        function: {
          name: restoreToolName(tc.name, toolNameMap),
          arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
        }
      }))
    }

    // Log usage data after stream is consumed (only if apiTimestamp is provided)
    if (apiTimestamp) {
      logApiUsage(
        {
          inputTokens,
          outputTokens,
          totalTokens,
          cacheReadInputTokens,
          cacheWriteInputTokens,
          contextUsagePercentage,
          credits: meteringUsage ?? undefined
        },
        apiTimestamp
      )
    }

    return new Response(JSON.stringify(oai), {
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
