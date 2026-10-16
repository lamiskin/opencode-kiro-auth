import { KIRO_CONSTANTS } from '../../constants.js'
import {
  convertImagesToKiroFormat,
  extractAllImages,
  extractTextFromParts
} from '../../plugin/image-handler.js'
import * as logger from '../../plugin/logger.js'
import type { CodeWhispererMessage } from '../../plugin/types'
import { getContentText } from './message-transformer.js'
import { deduplicateToolResults } from './tool-transformer.js'

/**
 * Collapse agentic loop sequences in the built history.
 *
 * Each agentic iteration gets a fresh conversationId, so the model re-derives its preamble
 * (intent detection, greeting) every iteration. When replayed for the next user turn, the
 * model sees duplicate preambles and gets confused.
 *
 * Strips text from intermediate ASST(toolUses)→USER(toolResults) pairs, keeping only the
 * first assistant text and all tool_use/tool_result pairs.
 */
export function collapseAgenticLoops(history: CodeWhispererMessage[]): CodeWhispererMessage[] {
  if (history.length < 4) return history

  const result: CodeWhispererMessage[] = []
  let i = 0

  while (i < history.length) {
    const entry = history[i]

    if (
      entry?.assistantResponseMessage?.toolUses &&
      i + 1 < history.length &&
      history[i + 1]?.userInputMessage?.userInputMessageContext?.toolResults
    ) {
      const seqStart = i

      let j = i
      while (j < history.length) {
        const asst = history[j]
        if (!asst?.assistantResponseMessage?.toolUses) break
        const nextUser = j + 1 < history.length ? history[j + 1] : null
        if (!nextUser?.userInputMessage?.userInputMessageContext?.toolResults) break
        j += 2
      }

      const seqEnd = j
      const pairCount = (seqEnd - seqStart) / 2

      if (pairCount > 1) {
        for (let k = seqStart; k < seqEnd; k += 2) {
          const asst = history[k]
          const user = history[k + 1]

          if (k === seqStart) {
            result.push(asst!)
          } else {
            result.push({
              assistantResponseMessage: {
                content: '[system: tool calling continues]',
                toolUses: asst!.assistantResponseMessage!.toolUses
              }
            })
          }
          result.push(user!)
        }
      } else {
        for (let k = seqStart; k < seqEnd; k++) {
          result.push(history[k]!)
        }
      }

      i = seqEnd
    } else {
      result.push(entry!)
      i++
    }
  }

  return result
}

export function buildHistory(msgs: any[], resolved: string): CodeWhispererMessage[] {
  let history: CodeWhispererMessage[] = []
  for (let i = 0; i < msgs.length - 1; i++) {
    const m = msgs[i]
    if (!m) continue
    if (m.role === 'user') {
      const uim: any = { content: '', modelId: resolved, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR }
      const trs: any[] = []

      if (Array.isArray(m.content)) {
        uim.content = extractTextFromParts(m.content)

        for (const p of m.content) {
          if (p.type === 'tool_result') {
            trs.push({
              content: [{ text: getContentText(p.content || p) }],
              status: 'success',
              toolUseId: p.tool_use_id
            })
          }
        }

        const unifiedImages = extractAllImages(m.content)
        if (unifiedImages.length > 0) {
          const { images, omitted } = convertImagesToKiroFormat(unifiedImages)
          uim.images = images
          if (omitted > 0) {
            uim.content += `\n\n[${omitted} image(s) omitted due to API limits]`
          }
        }
      } else {
        uim.content = getContentText(m)
      }

      if (trs.length) uim.userInputMessageContext = { toolResults: deduplicateToolResults(trs) }
      const prev = history[history.length - 1]
      if (prev && prev.userInputMessage)
        history.push({ assistantResponseMessage: { content: '[system: conversation continues]' } })
      history.push({ userInputMessage: uim })
    } else if (m.role === 'tool') {
      const trs: any[] = []
      if (m.tool_results) {
        for (const tr of m.tool_results)
          trs.push({
            content: [{ text: getContentText(tr) }],
            status: 'success',
            toolUseId: tr.tool_call_id
          })
      } else {
        trs.push({
          content: [{ text: getContentText(m) }],
          status: 'success',
          toolUseId: m.tool_call_id
        })
      }
      const prev = history[history.length - 1]
      if (prev && prev.userInputMessage)
        history.push({ assistantResponseMessage: { content: '[system: conversation continues]' } })
      history.push({
        userInputMessage: {
          content: 'Tool results provided.',
          modelId: resolved,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
          userInputMessageContext: { toolResults: deduplicateToolResults(trs) }
        }
      })
    } else if (m.role === 'assistant') {
      const arm: any = { content: '' }
      const tus: any[] = []
      let th = ''
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'text') arm.content += p.text || ''
          else if (p.type === 'thinking') th += p.thinking || p.text || ''
          else if (p.type === 'tool_use')
            tus.push({ input: p.input, name: p.name, toolUseId: p.id })
        }
      } else arm.content = getContentText(m)
      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          tus.push({
            input:
              typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function?.arguments,
            name: tc.function?.name,
            toolUseId: tc.id
          })
        }
      }
      if (th)
        arm.content = arm.content
          ? `<thinking>${th}</thinking>\n\n${arm.content}`
          : `<thinking>${th}</thinking>`
      if (tus.length) arm.toolUses = tus

      if (!arm.content && !arm.toolUses) {
        continue
      }

      const prevMsg = history[history.length - 1]
      if (prevMsg && prevMsg.assistantResponseMessage) {
        // Merge consecutive assistant messages instead of injecting synthetic user turn
        const prev = prevMsg.assistantResponseMessage
        if (arm.content) {
          prev.content = prev.content ? `${prev.content}\n\n${arm.content}` : arm.content
        }
        if (arm.toolUses) {
          prev.toolUses = [...(prev.toolUses || []), ...arm.toolUses]
        }
      } else {
        history.push({ assistantResponseMessage: arm })
      }
    }
  }
  return collapseAgenticLoops(history)
}

export function injectSystemPrompt(
  history: CodeWhispererMessage[],
  system: string | undefined,
  resolved: string
): CodeWhispererMessage[] {
  if (!system) return history
  const firstUserMsg = history.find((h) => !!h.userInputMessage)
  if (firstUserMsg && firstUserMsg.userInputMessage) {
    const oldContent = firstUserMsg.userInputMessage.content || ''
    firstUserMsg.userInputMessage.content = `${system}\n\n${oldContent}`
  } else {
    history.unshift({
      userInputMessage: {
        content: system,
        modelId: resolved,
        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
      }
    })
  }
  return history
}

export function trimHistory(
  history: CodeWhispererMessage[],
  maxEntries?: number,
  exact = false
): { history: CodeWhispererMessage[]; dropped: number; cap: number } {
  if (!maxEntries || maxEntries <= 0 || history.length <= maxEntries) {
    return { history, dropped: 0, cap: maxEntries || 0 }
  }

  const minFloor = 10
  const cap = Math.max(minFloor, maxEntries)
  if (history.length <= cap) {
    return { history, dropped: 0, cap }
  }

  // Assert history[0] is a user message; skip if not
  if (!history[0]?.userInputMessage) {
    logger.warn('trimHistory: history[0] missing userInputMessage, skipping trim')
    return { history, dropped: 0, cap }
  }

  const currentLen = history.length
  // Hysteresis: drop in 60-entry steps just enough to get back under cap, so the
  // cut point (and prompt prefix) only moves every ~60 turns: len 181 -> 121, 200 -> 140, 250 -> 130
  // exact (reactive retry): drop just enough to reach cap, no hysteresis
  let toDrop = exact ? currentLen - cap : Math.ceil((currentLen - cap) / 60) * 60
  // Round to even
  if (toDrop % 2 !== 0) toDrop++
  toDrop = Math.min(toDrop, currentLen - minFloor)

  const kept: CodeWhispererMessage[] = [history[0]!]
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  // First pass: collect tool IDs from dropped range to detect orphans
  for (let i = 1; i < 1 + toDrop && i < history.length; i++) {
    const entry = history[i]
    if (entry?.assistantResponseMessage?.toolUses) {
      for (const tu of entry.assistantResponseMessage.toolUses) {
        toolUseIds.add(tu.toolUseId)
      }
    }
    if (entry?.userInputMessage?.userInputMessageContext?.toolResults) {
      for (const tr of entry.userInputMessage.userInputMessageContext.toolResults) {
        toolResultIds.add(tr.toolUseId)
      }
    }
  }

  // Extend toDrop if cut would orphan a toolUses/toolResults pair at boundary
  while (1 + toDrop < history.length) {
    const nextEntry = history[1 + toDrop]
    if (nextEntry?.assistantResponseMessage?.toolUses) {
      const hasPairedResult = nextEntry.assistantResponseMessage.toolUses.some((tu) =>
        toolResultIds.has(tu.toolUseId)
      )
      if (hasPairedResult) {
        toDrop += 2
        continue
      }
    }
    if (nextEntry?.userInputMessage?.userInputMessageContext?.toolResults) {
      const hasPairedUse = nextEntry.userInputMessage.userInputMessageContext.toolResults.some(
        (tr) => toolUseIds.has(tr.toolUseId)
      )
      if (hasPairedUse) {
        toDrop += 2
        continue
      }
    }
    break
  }

  // Keep entries from index 1+toDrop onwards
  for (let i = 1 + toDrop; i < history.length; i++) {
    kept.push(history[i]!)
  }

  // Append truncation marker to history[0] user message content
  if (kept[0]?.userInputMessage) {
    const copy = { ...kept[0] }
    copy.userInputMessage = { ...kept[0].userInputMessage }
    const marker = `\n\n[Earlier conversation truncated: ${toDrop} messages omitted]`
    copy.userInputMessage.content = (kept[0].userInputMessage.content || '') + marker
    kept[0] = copy
  }

  return { history: kept, dropped: toDrop, cap }
}

export function historyHasToolCalling(history: CodeWhispererMessage[]): boolean {
  return history.some(
    (h) =>
      h.assistantResponseMessage?.toolUses ||
      h.userInputMessage?.userInputMessageContext?.toolResults
  )
}

export function extractToolNamesFromHistory(history: CodeWhispererMessage[]): Set<string> {
  const toolNames = new Set<string>()
  for (const h of history) {
    if (h.assistantResponseMessage?.toolUses) {
      for (const tu of h.assistantResponseMessage.toolUses) {
        if (tu.name) toolNames.add(tu.name)
      }
    }
  }
  return toolNames
}
