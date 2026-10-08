import { Buffer } from 'node:buffer'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const binaryToBase64Replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return value
}

const getLogDir = () => {
  const platform = process.platform
  const base =
    platform === 'win32'
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
  return join(base, 'kiro-logs')
}

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
  } catch (e) {}
}

const writeApiLog = (
  type: 'request' | 'response',
  data: any,
  timestamp: string,
  isError = false
) => {
  try {
    const dir = getLogDir()
    mkdirSync(dir, { recursive: true })
    const prefix = isError ? 'error_' : ''
    const filename = `${prefix}${timestamp}_${type}.json`
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
  writeApiLog('request', requestData, timestamp, true)
  writeApiLog('response', responseData, timestamp, true)
  const errorType = responseData.status ? `HTTP ${responseData.status}` : 'Network Error'
  const email = requestData.email || 'unknown'
  error(`${errorType} on ${email} - See error_${timestamp}_request.json`)
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

    // Get model rate if we have a model
    let rate = '1.0x'
    const model = existingData?.model
    if (model) {
      // ponytail: Secondary source of truth - must be kept in sync with src/plugin/model-catalog.ts
      // (BUNDLED_MODEL_CATALOG) and src/plugin/model-registry.ts. When adding/changing a model's rate
      // in those files, it must also be updated here to avoid circular dependency.
      const rateMap: Record<string, string> = {
        // Claude Opus 5.x
        'claude-opus-5-5': '2.2x',
        'claude-opus-5': '2.2x',
        'claude-opus-4-8': '2.2x',
        'claude-opus-4-7': '2.2x',
        'claude-opus-4-6': '2.2x',
        'claude-opus-4-5': '2.2x',
        // Claude Sonnet 5.x
        'claude-sonnet-5-5': '1.3x',
        'claude-sonnet-5': '1.3x',
        'claude-sonnet-4-6': '1.3x',
        'claude-sonnet-4-5': '1.3x',
        'claude-sonnet-4': '1.3x',
        // Claude Fable 5.x
        'claude-fable-5-1': '0.5x',
        'claude-haiku-4-5': '0.4x',
        'gpt-5.6-sol': '4.4x',
        'gpt-5.6-terra': '2.2x',
        'gpt-5.6-luna': '0.6x',
        'deepseek-3.2': '0.25x',
        'minimax-m2.5': '0.25x',
        'glm-5': '0.5x',
        'minimax-m2.1': '0.15x',
        'qwen3-coder-next': '0.05x',
        auto: '1.0x'
      }
      rate = rateMap[model] ?? '1.0x'
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
