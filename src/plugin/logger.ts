import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { rateForLog } from './model-rate.js'
import { estimateTokens as responseEstimateTokens } from './response.js'

const binaryToBase64Replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return value
}

// Retention and rotation: delete old log files, rotate plugin.log at 10MB
const pruneOldLogs = (logDir: string, retentionDays: number) => {
  if (retentionDays <= 0) return
  try {
    const cutoff = new Date(Date.now() - retentionDays * 86400000)
    const files = readdirSync(logDir)
    for (const file of files) {
      // Only prune files matching the timestamped log pattern
      if (
        !/^(error_)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_(request|response|shape)\.json$/.test(
          file
        )
      )
        continue
      const filePath = join(logDir, file)
      const stat = statSync(filePath)
      if (stat.mtimeMs < cutoff.getTime()) {
        rmSync(filePath, { force: true })
      }
    }
  } catch (e) {}
}

const rotatePluginLog = (logDir: string, logPath: string) => {
  try {
    if (!existsSync(logPath)) return
    const stat = statSync(logPath)
    if (stat.size > 10 * 1024 * 1024) {
      const backupPath = logPath + '.1'
      renameSync(logPath, backupPath)
    }
  } catch (e) {}
}

const getLogDir = () => {
  const platform = process.platform
  const base =
    platform === 'win32'
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
  return join(base, 'kiro-logs')
}

// One-time initialization: prune old logs and rotate plugin.log
let initialized = false
export function initializeLogs(retentionDays: number): void {
  if (initialized) return
  initialized = true
  try {
    const logDir = getLogDir()
    mkdirSync(logDir, { recursive: true })
    pruneOldLogs(logDir, retentionDays)
    rotatePluginLog(logDir, join(logDir, 'plugin.log'))
  } catch (e) {}
}

let writeCounter = 0
const writeToFile = (level: string, message: string, ...args: unknown[]) => {
  try {
    const dir = getLogDir()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'plugin.log')
    const timestamp = new Date().toISOString()
    const content = `[${timestamp}] ${level}: ${message} ${args
      .map((a) => {
        if (a instanceof Error) {
          return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`
        }
        if (typeof a === 'object') {
          try {
            return JSON.stringify(a)
          } catch {
            return '[Unserializable object]'
          }
        }
        return String(a)
      })
      .join(' ')}\n`
    appendFileSync(path, content)
    if (++writeCounter % 200 === 0) {
      rotatePluginLog(dir, path)
    }
  } catch (e) {}
}

const writeApiLog = (type: 'request' | 'response', data: any, timestamp: string) => {
  try {
    const dir = getLogDir()
    mkdirSync(dir, { recursive: true })
    const filename = `${timestamp}_${type}.json`
    const path = join(dir, filename)
    const content = JSON.stringify(data, binaryToBase64Replacer, 2)
    writeFileSync(path, content)
  } catch (e) {}
}

export function log(message: string, ...args: unknown[]): void {
  writeToFile('INFO', message, ...args)
}

export function error(message: string, ...args: unknown[]): void {
  writeToFile('ERROR', message, ...args)
}

export function warn(message: string, ...args: unknown[]): void {
  writeToFile('WARN', message, ...args)
}

export function debug(message: string, ...args: unknown[]): void {
  if (process.env.DEBUG) {
    writeToFile('DEBUG', message, ...args)
  }
}

export function logApiRequest(data: any, timestamp: string): void {
  writeApiLog('request', data, timestamp)
}

export function logApiResponse(data: any, timestamp: string): void {
  writeApiLog('response', data, timestamp)
}

export function logApiError(requestData: any, responseData: any, timestamp: string): void {
  writeApiLog('request', requestData, timestamp)
  writeApiLog('response', responseData, timestamp)
  const errorType = responseData.status ? `HTTP ${responseData.status}` : 'Network Error'
  const email = requestData.email || 'unknown'
  error(`${errorType} on ${email} - See ${timestamp}_request.json`)
}

/**
 * Redact sensitive content from a request object:
 * - Replace currentMessage.userInputMessage.content with length + sha256 prefix
 * - Replace email with length + sha256 prefix
 */
export function redactRequestContent(data: any): any {
  const copy = { ...data }
  if (copy.email) {
    const hash = createHash('sha256').update(copy.email).digest('hex').slice(0, 8)
    copy.email = `[len=${String(copy.email).length}#${hash}]`
  }
  if (copy.body?.conversationState?.currentMessage?.userInputMessage?.content) {
    const content = copy.body.conversationState.currentMessage.userInputMessage.content
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 8)
    copy.body = {
      ...copy.body,
      conversationState: {
        ...copy.body.conversationState,
        currentMessage: {
          ...copy.body.conversationState.currentMessage,
          userInputMessage: {
            ...copy.body.conversationState.currentMessage.userInputMessage,
            content: `[len=${String(content).length}#${hash}]`
          }
        }
      }
    }
  }
  return copy
}

// Compact per-entry shape: [role, chars, toolUses, toolResults]
function entryToShape(entry: any): [string, number, number, number] {
  const chars = JSON.stringify(entry).length
  // Determine role from which key exists
  const role = entry.userInputMessage ? 'u' : entry.assistantResponseMessage ? 'a' : '?'
  // Count tool invocations and results
  const toolUses = entry.assistantResponseMessage?.toolUses?.length || 0
  const toolResults = entry.userInputMessage?.userInputMessageContext?.toolResults?.length || 0
  return [role, chars, toolUses, toolResults]
}

export function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export interface ApiUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  contextUsagePercentage?: number
  credits?: number
  rate?: string
}

/**
 * Appends shape diagnostics to a shape log file (opt-in, separate from request/response logs).
 * Contains model, sizes, historyShape, tools list, attempt number, session id.
 */
export function logShape(shape: any, timestamp: string): void {
  try {
    const dir = getLogDir()
    mkdirSync(dir, { recursive: true })
    const filename = `${timestamp}_shape.json`
    const path = join(dir, filename)
    const content = JSON.stringify(shape, binaryToBase64Replacer, 2)
    writeFileSync(path, content)
  } catch (e) {}
}

/**
 * Appends usage data to an existing response log file.
 * Reads the existing `${timestamp}_response.json`, merges in the usage fields, and rewrites.
 */
export function logApiUsage(usage: ApiUsage, timestamp: string): void {
  if (!timestamp) return
  try {
    const dir = getLogDir()
    const filename = `${timestamp}_response.json`
    const path = join(dir, filename)

    // Read existing response data
    let existingData: any = {}
    try {
      const content = readFileSync(path, 'utf-8')
      existingData = JSON.parse(content)
    } catch {
      // File doesn't exist yet, start fresh
    }

    // Get model rate from the authoritative catalog
    let rate = '1.0x'
    const model = existingData?.model
    if (model) {
      rate = rateForLog(model, warn)
    }

    // Merge usage data
    const merged = {
      ...existingData,
      usage: {
        ...(existingData.usage || {}),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
        contextUsagePercentage: usage.contextUsagePercentage,
        credits: usage.credits,
        rate
      }
    }

    writeFileSync(path, JSON.stringify(merged, binaryToBase64Replacer, 2))
  } catch (e) {
    // Silently fail - logging should not break the main flow
  }
}

export { responseEstimateTokens as estimateTokens }
export function computeHistoryShape(history: any[]): [string, number, number, number][] {
  return history.map(entryToShape)
}

export function computeHistoryHashes(history: any[]): string[] {
  return history.map((entry) =>
    createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 8)
  )
}
