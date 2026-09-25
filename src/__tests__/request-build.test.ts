import { describe, expect, test } from 'bun:test'
import { transformToSdkRequest } from '../plugin/request.js'

const MODEL = 'claude-sonnet-4-5'

const auth: any = {
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 60_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

describe('buildCodeWhispererRequest characterization', () => {
  test('system prompt merge: system field + role:system messages joined with double newlines', () => {
    const prepared: any = transformToSdkRequest(
      {
        system: 'Base system prompt',
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'First response' },
          { role: 'system', content: 'System message one' },
          { role: 'system', content: 'System message two' },
          { role: 'user', content: 'Hello' }
        ]
      },
      MODEL,
      auth
    )
    // System prompt gets prepended to first user message content
    const firstUserMsg = prepared.conversationState.history.find(
      (h: any) => h.userInputMessage?.content
    )
    const content = firstUserMsg?.userInputMessage?.content
    expect(content).toContain('Base system prompt')
    expect(content).toContain('System message one')
    expect(content).toContain('System message two')
    expect(content).toContain('\n\n')
  })

  test('think=true prepends thinking_mode and max_thinking_length; existing thinking_mode untouched', () => {
    const preparedWithout: any = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Hi' },
          { role: 'user', content: 'Think about this' }
        ]
      },
      MODEL,
      auth,
      false
    )
    const firstUserMsg = preparedWithout.conversationState.history.find(
      (h: any) => h.userInputMessage?.content
    )
    const sysNoThink = firstUserMsg?.userInputMessage?.content
    expect(sysNoThink).not.toContain('<thinking_mode>')

    const preparedWith: any = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Hi' },
          { role: 'user', content: 'Think about this' }
        ]
      },
      MODEL,
      auth,
      true,
      25000
    )
    const firstUserMsg2 = preparedWith.conversationState.history.find(
      (h: any) => h.userInputMessage?.content
    )
    const sysWithThink = firstUserMsg2?.userInputMessage?.content
    expect(sysWithThink).toContain('<thinking_mode>enabled</thinking_mode>')
    expect(sysWithThink).toContain('<max_thinking_length>25000</max_thinking_length>')

    const preparedExisting: any = transformToSdkRequest(
      {
        system: 'Custom <thinking_mode>custom</thinking_mode> prompt',
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: 'Hi' },
          { role: 'user', content: 'Hello' }
        ]
      },
      MODEL,
      auth,
      true,
      30000
    )
    const firstUserMsg3 = preparedExisting.conversationState.history.find(
      (h: any) => h.userInputMessage?.content
    )
    const sysExisting = firstUserMsg3?.userInputMessage?.content
    expect(sysExisting).toContain('<thinking_mode>custom</thinking_mode>')
    expect(sysExisting).not.toContain('<thinking_mode>enabled</thinking_mode>')
  })

  test('trailing assistant message with text exactly "{" is dropped', () => {
    const prepared: any = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'Real question' },
          { role: 'assistant', content: '{' }
        ]
      },
      MODEL,
      auth
    )

    expect(prepared.conversationState.currentMessage.userInputMessage.content).toBe('Real question')
  })

  test('last is real user turn, previous is assistant, history ends with userInputMessage -> assistant text appended to history', () => {
    const prepared: any = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'First question' },
          { role: 'assistant', content: 'First answer' },
          { role: 'user', content: 'Second question' }
        ]
      },
      MODEL,
      auth
    )
    const history = prepared.conversationState.history
    const currentContent = prepared.conversationState.currentMessage.userInputMessage.content
    expect(currentContent).toContain('Second question')
    const assistantEntry = history.find(
      (h: any) => h.assistantResponseMessage?.content === 'First answer'
    )
    expect(assistantEntry).toBeDefined()
  })

  test('last is assistant turn -> folded into history as assistantResponseMessage, currentMessage becomes [system: conversation continues], thinking wrapped, OpenAI tool_calls parsed', () => {
    const prepared: any = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'Run a tool' },
          {
            role: 'assistant',
            content: 'I will use the tool',
            tool_calls: [
              {
                id: 'call-123',
                type: 'function',
                function: { name: 'search_docs', arguments: '{"query":"test"}' }
              }
            ]
          }
        ]
      },
      MODEL,
      auth
    )
    const history = prepared.conversationState.history
    const arm = history.find((h: any) => h.assistantResponseMessage)
    expect(arm?.assistantResponseMessage?.content).toContain('I will use the tool')
    expect(arm?.assistantResponseMessage?.toolUses).toEqual([
      { input: { query: 'test' }, name: 'search_docs', toolUseId: 'call-123' }
    ])
    expect(prepared.conversationState.currentMessage.userInputMessage.content).toBe(
      '[system: conversation continues]'
    )
  })

  test('assistant message with thinking parts wraps them in <thinking> tags', () => {
    const prepared: any = transformToSdkRequest(
      {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Let me think about this...' },
              { type: 'text', text: 'Here is my answer.' }
            ]
          }
        ]
      },
      MODEL,
      auth
    )
    const history = prepared.conversationState.history
    const arm = history.find((h: any) => h.assistantResponseMessage)
    expect(arm?.assistantResponseMessage?.content).toContain('<thinking>')
    expect(arm?.assistantResponseMessage?.content).toContain('Let me think about this...')
    expect(arm?.assistantResponseMessage?.content).toContain('</thinking>')
  })

  test('role:tool message in both shapes: with tool_results array and bare with tool_call_id', () => {
    const preparedWithArray: any = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'Use tool' },
          {
            role: 'assistant',
            content: 'Using tool',
            tool_calls: [
              { id: 'call-result-1', type: 'function', function: { name: 'tool', arguments: '{}' } }
            ]
          },
          {
            role: 'tool',
            tool_results: [{ tool_call_id: 'call-result-1', content: 'Tool result output' }]
          }
        ]
      },
      MODEL,
      auth
    )
    const tr1 =
      preparedWithArray.conversationState.currentMessage.userInputMessage.userInputMessageContext
        ?.toolResults
    expect(tr1).toBeDefined()
    expect(tr1[0].toolUseId).toBe('call-result-1')
    expect(tr1[0].content[0].text).toBe('Tool result output')

    const preparedBare: any = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'Use tool' },
          {
            role: 'assistant',
            content: 'Using tool',
            tool_calls: [
              { id: 'call-result-2', type: 'function', function: { name: 'tool', arguments: '{}' } }
            ]
          },
          { role: 'tool', tool_call_id: 'call-result-2', content: 'Bare tool result' }
        ]
      },
      MODEL,
      auth
    )
    const tr2 =
      preparedBare.conversationState.currentMessage.userInputMessage.userInputMessageContext
        ?.toolResults
    expect(tr2).toBeDefined()
    expect(tr2[0].toolUseId).toBe('call-result-2')
    expect(tr2[0].content[0].text).toBe('Bare tool result')
  })

  test('content array with tool_result parts -> userInputMessageContext.toolResults; empty text falls back to "Tool results provided."', () => {
    const prepared: any = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'Use tool' },
          {
            role: 'assistant',
            content: 'Using tool',
            tool_calls: [
              {
                id: 'call-tool-result-x',
                type: 'function',
                function: { name: 'tool', arguments: '{}' }
              }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-tool-result-x',
                content: 'Result from array part'
              }
            ]
          }
        ]
      },
      MODEL,
      auth
    )
    const tr =
      prepared.conversationState.currentMessage.userInputMessage.userInputMessageContext
        ?.toolResults
    expect(tr).toBeDefined()
    expect(tr[0].toolUseId).toBe('call-tool-result-x')
    expect(tr[0].content[0].text).toBe('Result from array part')

    const preparedEmpty: any = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'Use tool' },
          {
            role: 'assistant',
            content: 'Using tool',
            tool_calls: [
              {
                id: 'call-tool-result-y',
                type: 'function',
                function: { name: 'tool', arguments: '{}' }
              }
            ]
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call-tool-result-y', content: '' }]
          }
        ]
      },
      MODEL,
      auth
    )
    expect(preparedEmpty.conversationState.currentMessage.userInputMessage.content).toBe(
      'Tool results provided.'
    )
  })

  // The assistant tool call is in history when the trailing tool result becomes current,
  // so the result is matched normally rather than treated as orphaned.
  test('tool result for assistant tool call is matched and included in toolResults', () => {
    const prepared: any = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'First' },
          {
            role: 'assistant',
            content: 'Calling tool',
            tool_calls: [
              { id: 'call-1', type: 'function', function: { name: 'mytool', arguments: '{}' } }
            ]
          },
          { role: 'tool', tool_call_id: 'call-1', content: 'Result' }
        ]
      },
      MODEL,
      auth
    )
    // Tool call is in history, so result goes to toolResults
    const tr =
      prepared.conversationState.currentMessage.userInputMessage.userInputMessageContext
        ?.toolResults
    expect(tr).toBeDefined()
    expect(tr[0].toolUseId).toBe('call-1')
  })

  test('orphaned tool result with no matching original call -> inline appended to currentMessage content', () => {
    const prepared: any = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'tool', tool_call_id: 'nonexistent-call', content: 'Mystery result' }
        ]
      },
      MODEL,
      auth
    )
    const content = prepared.conversationState.currentMessage.userInputMessage.content
    expect(content).toContain('[Output for tool call nonexistent-call]:')
    expect(content).toContain('Mystery result')
  })

  test('history contains tool names absent from current tools[] -> placeholder tool specs synthesized', () => {
    const prepared: any = transformToSdkRequest(
      {
        messages: [
          {
            role: 'assistant',
            content: 'Used a historical tool',
            tool_calls: [
              {
                id: 'h1',
                type: 'function',
                function: { name: 'historical_tool_abc', arguments: '{}' }
              }
            ]
          }
        ],
        tools: [
          {
            type: 'function',
            function: { name: 'other_tool', description: 'Other', parameters: {} }
          }
        ]
      },
      MODEL,
      auth
    )
    const tools =
      prepared.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools
    expect(tools).toBeDefined()
    const placeholder = tools?.find((t: any) => t.toolSpecification?.name === 'historical_tool_abc')
    expect(placeholder).toBeDefined()
    expect(placeholder.toolSpecification.description).toBe('Tool')
    expect(placeholder.toolSpecification.inputSchema).toEqual({
      json: { type: 'object', properties: {} }
    })
    const actual = tools?.find((t: any) => t.toolSpecification?.name === 'other_tool')
    expect(actual).toBeDefined()
  })
})
